// SPDX-License-Identifier: AGPL-3.0-or-later
// http.ts — execute a single OpenAPI operation as an HTTP request.
// SECURITY-CRITICAL: credential injected ONLY into the HTTP request.
// No secret in tool results, errors, logs, or URLs surfaced anywhere.
// SOURCE-AGNOSTIC: no vendor-specific code.

import type { OpenApiAuth, OpenApiConnection, ToolResult, UpstreamError } from "@junction/core"
import { err, ok, ResultAsync } from "neverthrow"
import { deriveNameFromMethodPath, sanitizeOperationId } from "./naming.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30_000
export const RESPONSE_BYTE_CAP = 1_048_576 // 1 MB

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface OpenApiParameter {
  name?: unknown
  in?: unknown
  required?: unknown
}

interface OpenApiOperation {
  parameters?: unknown
  requestBody?: unknown
}

interface OpenApiServer {
  url?: unknown
}

// ---------------------------------------------------------------------------
// Path-injection guard
// ---------------------------------------------------------------------------

/**
 * Validate a path parameter value for injection safety.
 * Rejects values containing /, .., control chars, or URL scheme/host patterns.
 */
function validatePathValue(value: string): string | null {
  if (value.includes("/")) return "path segment must not contain '/'"
  if (value.includes("..")) return "path segment must not contain '..'"
  // Check for control characters (U+0000–U+001F, U+007F)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return "path segment must not contain control characters"
  }
  // Reject host-like patterns (scheme or bare host)
  if (/^https?:\/\//i.test(value)) return "path segment must not contain a URL scheme"
  return null
}

// ---------------------------------------------------------------------------
// Derive base URL from spec servers
// ---------------------------------------------------------------------------

function resolveBaseUrl(
  connection: OpenApiConnection,
  schema: Record<string, unknown>,
): string | null {
  if (connection.baseUrl) return connection.baseUrl

  const servers = schema.servers
  if (!Array.isArray(servers) || servers.length === 0) return null

  const firstServer = servers[0] as OpenApiServer
  const url = firstServer.url
  if (typeof url !== "string" || url.length === 0) return null

  // Only allow http / https
  if (!/^https?:\/\//i.test(url)) return null
  return url.replace(/\/$/, "")
}

// ---------------------------------------------------------------------------
// Credential injection helpers
// ---------------------------------------------------------------------------

/**
 * Inject auth credential into request headers/URL-params.
 *
 * SECURITY: The secret never appears in logs, error messages, or returned output.
 * For apiKey-in-query: the URL with the key is NEVER logged or returned in results.
 */
function injectAuth(
  auth: OpenApiAuth | undefined,
  secret: string | null,
  headers: Record<string, string>,
  queryParams: URLSearchParams,
): void {
  if (!auth || secret === null) return

  switch (auth.scheme) {
    case "apiKey":
      if (auth.in === "header") {
        headers[auth.name] = secret
      } else if (auth.in === "query") {
        // Secret in query string — MUST NOT be surfaced in any output
        queryParams.set(auth.name, secret)
      } else if (auth.in === "cookie") {
        const existing = headers.Cookie ?? ""
        headers.Cookie = existing ? `${existing}; ${auth.name}=${secret}` : `${auth.name}=${secret}`
      }
      break
    case "bearer": {
      const headerName = auth.header ?? "Authorization"
      headers[headerName] = `Bearer ${secret}`
      break
    }
    case "basic": {
      const encoded = Buffer.from(`${auth.username}:${secret}`).toString("base64")
      headers.Authorization = `Basic ${encoded}`
      break
    }
    case "oauth2":
      headers.Authorization = `Bearer ${secret}`
      break
  }
}

// ---------------------------------------------------------------------------
// findOperation
// ---------------------------------------------------------------------------

interface FoundOperation {
  path: string
  method: string
  operation: OpenApiOperation
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

function findOperation(
  schema: Record<string, unknown>,
  operationName: string,
): FoundOperation | null {
  const paths = schema.paths
  if (paths === null || typeof paths !== "object") return null

  for (const [path, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (pathItem === null || typeof pathItem !== "object") continue
    const item = pathItem as Record<string, unknown>

    for (const method of HTTP_METHODS) {
      const op = item[method]
      if (op === null || op === undefined || typeof op !== "object") continue
      const operation = op as Record<string, unknown>

      // Match by operationId (sanitized) or derive from method+path
      const opId = typeof operation.operationId === "string" ? operation.operationId : ""
      const sanitized = sanitizeOperationId(opId)
      const derived = deriveNameFromMethodPath(method, path)

      if (sanitized === operationName || derived === operationName) {
        return { path, method, operation: operation as OpenApiOperation }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// callOperation — main entry point
// ---------------------------------------------------------------------------

/**
 * Execute an OpenAPI operation by name with the given args.
 *
 * SECURITY:
 * - Secret injected ONLY into HTTP request (header / query / cookie / bearer / basic).
 * - apiKey-in-query: URL is NEVER logged or returned.
 * - Host is pinned to connection.baseUrl or spec servers[0]; agent args fill only
 *   path/query/body values, never scheme/host/path-template.
 * - Path param injection guarded (no / .. control chars).
 * - 1 MB response cap + 30s timeout.
 */
export function callOperation(
  schema: Record<string, unknown>,
  connection: OpenApiConnection,
  secret: string | null,
  operationName: string,
  args: Record<string, unknown>,
): ResultAsync<ToolResult, UpstreamError> {
  return new ResultAsync(callOperationAsync(schema, connection, secret, operationName, args))
}

async function callOperationAsync(
  schema: Record<string, unknown>,
  connection: OpenApiConnection,
  secret: string | null,
  operationName: string,
  args: Record<string, unknown>,
) {
  // Find the operation in the schema
  const found = findOperation(schema, operationName)
  if (!found) {
    return err<ToolResult, UpstreamError>({ kind: "tool-not-found", name: operationName })
  }

  const { path, method, operation } = found

  // Resolve base URL (host-pinned — agent args NEVER override this)
  const baseUrl = resolveBaseUrl(connection, schema)
  if (!baseUrl) {
    return err<ToolResult, UpstreamError>({
      kind: "connect-failed",
      cause: "no base URL: set --base-url or include a servers entry in the spec",
    })
  }

  // Validate base URL scheme
  if (!/^https?:\/\//i.test(baseUrl)) {
    return err<ToolResult, UpstreamError>({
      kind: "connect-failed",
      cause: `base URL scheme must be http or https`,
    })
  }

  // Build path (substitute path params)
  const params = Array.isArray(operation.parameters) ? operation.parameters : []
  let resolvedPath = path

  for (const p of params) {
    if (p === null || typeof p !== "object") continue
    const param = p as OpenApiParameter
    if (param.in !== "path" || typeof param.name !== "string") continue

    const val = args[param.name]
    if (val === undefined || val === null) {
      if (param.required === true) {
        return err<ToolResult, UpstreamError>({
          kind: "invalid-args",
          reason: `missing required path parameter: ${param.name}`,
        })
      }
      continue
    }

    const strVal = String(val)
    const injectionError = validatePathValue(strVal)
    if (injectionError) {
      return err<ToolResult, UpstreamError>({ kind: "invalid-args", reason: injectionError })
    }

    resolvedPath = resolvedPath.replace(`{${param.name}}`, encodeURIComponent(strVal))
  }

  // Build headers and query params
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(connection.defaultHeaders ?? {}),
  }
  const queryParams = new URLSearchParams()

  // Add query params from args
  for (const p of params) {
    if (p === null || typeof p !== "object") continue
    const param = p as OpenApiParameter
    if (param.in !== "query" || typeof param.name !== "string") continue

    const val = args[param.name]
    if (val !== undefined && val !== null) {
      queryParams.set(param.name, String(val))
    }
  }

  // Add header params from args
  for (const p of params) {
    if (p === null || typeof p !== "object") continue
    const param = p as OpenApiParameter
    if (param.in !== "header" || typeof param.name !== "string") continue

    const val = args[param.name]
    if (val !== undefined && val !== null) {
      headers[param.name] = String(val)
    }
  }

  // Inject credential into request (ONLY here — never in result/log/URL-output)
  injectAuth(connection.auth, secret, headers, queryParams)

  // Build body
  let body: string | undefined
  if (args.body !== undefined && args.body !== null) {
    try {
      body = JSON.stringify(args.body)
    } catch (_cause) {
      return err<ToolResult, UpstreamError>({
        kind: "invalid-args",
        reason: "body is not JSON-serializable",
      })
    }
  } else if (method !== "get" && method !== "head" && method !== "delete") {
    // No Content-Type for methods without body
    delete headers["Content-Type"]
  }

  // Build final URL (host is pinned; agent cannot override baseUrl)
  const queryString = queryParams.toString()
  // NOTE: we do NOT log or return this URL — it may contain an apiKey-in-query secret
  const fullUrl = `${baseUrl}${resolvedPath}${queryString ? `?${queryString}` : ""}`

  // Execute with timeout and byte cap
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const res = await fetch(fullUrl, {
      method: method.toUpperCase(),
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    })

    clearTimeout(timer)

    // Stream response with byte cap
    const reader = res.body?.getReader()
    if (!reader) {
      const text = await res.text()
      const responseText = `${res.status} ${res.statusText}\n${text}`
      return ok<ToolResult, UpstreamError>({
        content: [{ type: "text", text: responseText }],
        isError: res.status >= 400,
      })
    }

    const chunks: Uint8Array[] = []
    let totalBytes = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        totalBytes += value.byteLength
        if (totalBytes > RESPONSE_BYTE_CAP) {
          reader.cancel().catch(() => {})
          return err<ToolResult, UpstreamError>({
            kind: "response-too-large",
            limit: RESPONSE_BYTE_CAP,
          })
        }
        chunks.push(value)
      }
    }

    const bodyText = Buffer.concat(chunks).toString("utf8")
    // Return status + body but NOT the request URL (which may contain secrets in query)
    const responseText = `${res.status} ${res.statusText}\n${bodyText}`

    return ok<ToolResult, UpstreamError>({
      content: [{ type: "text", text: responseText }],
      isError: res.status >= 400,
    })
  } catch (cause) {
    clearTimeout(timer)
    // Check if aborted (timeout)
    if (
      cause !== null &&
      typeof cause === "object" &&
      "name" in cause &&
      (cause as { name: unknown }).name === "AbortError"
    ) {
      return err<ToolResult, UpstreamError>({ kind: "timed-out", ms: DEFAULT_TIMEOUT_MS })
    }
    return err<ToolResult, UpstreamError>({ kind: "call-failed", cause })
  }
}
