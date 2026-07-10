// SPDX-License-Identifier: AGPL-3.0-only
// http.ts — execute a single OpenAPI operation as an HTTP request.
// SECURITY-CRITICAL: credential injected ONLY into the HTTP request.
// No secret in tool results, errors, logs, or URLs surfaced anywhere.
// SOURCE-AGNOSTIC: no vendor-specific code.
//
// FACTORING (increment 30.7): the schema-agnostic "build + execute a request
// from a resolved (baseUrl, method, pathTemplate, typed params, auth, secret,
// defaultHeaders, args, timeoutMs)" engine lives in `buildAndExecuteRequest`
// (below). It has TWO consumers: `callOperation` here (OpenAPI — resolves the
// operation from a parsed spec first, then delegates) and
// `@junction/http-client`'s `createHttpProvider` (operator-declared REST
// tools — the tool IS the resolved operation, no spec lookup needed). Do NOT
// fork this logic — both providers must share ONE copy (see
// docs/futures/gotchas.md).

import {
  type OpenApiAuth,
  type OpenApiConnection,
  rejectControlCharacters,
  type ToolResult,
  type UpstreamError,
} from "@junction/core"
import { err, ok, type Result, ResultAsync } from "neverthrow"
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
export function validatePathValue(value: string): string | null {
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
  // Validate parseable (catches malformed hosts that pass the regex)
  try {
    new URL(url)
  } catch {
    return null
  }
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
export function injectAuth(
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
// buildAndExecuteRequest — the shared, schema-agnostic request engine
// ---------------------------------------------------------------------------

/** A single param location declared by the caller — the schema-agnostic shape both
 * OpenAPI (extracted from the spec op) and http-client (from HttpRequestTool.params)
 * reduce their params to before calling the shared engine. */
export interface BoundParam {
  name: string
  in: "path" | "query" | "header" | "body" | "cookie"
  required: boolean
}

export interface BuildAndExecuteRequestArgs {
  /** Already resolved, host-pinned. Agent args never set the host. */
  baseUrl: string
  /** HTTP method — any case; normalized before fetch. */
  method: string
  /** Path template, e.g. "/repos/{owner}/{repo}" — {placeholders} bind to `in:"path"` params. */
  pathTemplate: string
  /** Declared params with their binding location. */
  params: BoundParam[]
  auth: OpenApiAuth | undefined
  secret: string | null
  defaultHeaders: Record<string, string> | undefined
  /** The agent's validated args, keyed by param name. */
  args: Record<string, unknown>
  timeoutMs: number
  /**
   * Which key in `args` carries the JSON body value. OpenAPI hardcodes "body"
   * (its merged inputSchema always uses that key); http-client passes the
   * name of its one `in:"body"` param (the operator names it). Defaults to
   * "body" so OpenAPI's call site needs no change.
   */
  bodyArgKey?: string
}

/**
 * Build and execute an HTTP request from a resolved, schema-agnostic
 * description of the call. Shared by openapi-client's `callOperation` (after
 * it resolves an operation from a parsed spec) and `@junction/http-client`'s
 * `createHttpProvider` (the tool IS the resolved operation already).
 *
 * SECURITY (identical to the pre-extraction behaviour):
 * - Secret injected ONLY into HTTP request (header / query / cookie / bearer / basic).
 * - apiKey-in-query: URL is NEVER logged or returned.
 * - Host is pinned to `baseUrl`; agent args fill only path/query/header/body
 *   values, never scheme/host/path-template.
 * - Path param injection guarded (no / .. control chars).
 * - 1 MB response cap + timeout.
 */
export function buildAndExecuteRequest(
  reqArgs: BuildAndExecuteRequestArgs,
): ResultAsync<ToolResult, UpstreamError> {
  return new ResultAsync(buildAndExecuteRequestAsync(reqArgs))
}

async function buildAndExecuteRequestAsync({
  baseUrl,
  method,
  pathTemplate,
  params,
  auth,
  secret,
  defaultHeaders,
  args,
  timeoutMs,
  bodyArgKey = "body",
}: BuildAndExecuteRequestArgs): Promise<Result<ToolResult, UpstreamError>> {
  // Validate base URL scheme
  if (!/^https?:\/\//i.test(baseUrl)) {
    return err<ToolResult, UpstreamError>({
      kind: "connect-failed",
      cause: `base URL scheme must be http or https`,
    })
  }

  const methodLower = method.toLowerCase()

  // Build path (substitute path params)
  let resolvedPath = pathTemplate

  for (const param of params) {
    if (param.in !== "path") continue

    const val = args[param.name]
    if (val === undefined || val === null) {
      if (param.required) {
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
    ...(defaultHeaders ?? {}),
  }
  const queryParams = new URLSearchParams()

  // Add query params from args
  for (const param of params) {
    if (param.in !== "query") continue

    const val = args[param.name]
    if (val !== undefined && val !== null) {
      const strVal = String(val)
      // Control-char guard (32.13 Slice D2, defense-in-depth): URLSearchParams
      // percent-encodes the value, so this is not exploitable via query TODAY,
      // but mirrors http-client's validateHttpArgs (which already rejects this
      // for the operator-declared REST surface) for parity across the two
      // consumers of this shared engine — a future encoding change here should
      // not silently reopen the gap this guard closes for http-client.
      const controlCharResult = rejectControlCharacters(strVal, `query param "${param.name}"`)
      if (controlCharResult.isErr()) {
        return err<ToolResult, UpstreamError>(controlCharResult.error)
      }
      queryParams.set(param.name, strVal)
    }
  }

  // Add header params from args
  for (const param of params) {
    if (param.in !== "header") continue

    const val = args[param.name]
    if (val !== undefined && val !== null) {
      const strVal = String(val)
      // Control-char guard (32.13 Slice D2): undici throws on a raw CR/LF in a
      // header value today (mitigating header-injection), but that's an
      // implementation detail of the fetch client, not a validated contract —
      // reject explicitly here so the behavior doesn't depend on undici's
      // internals and so OpenAPI gets the SAME defense-in-depth http-client's
      // validateHttpArgs already applies.
      const controlCharResult = rejectControlCharacters(strVal, `header param "${param.name}"`)
      if (controlCharResult.isErr()) {
        return err<ToolResult, UpstreamError>(controlCharResult.error)
      }
      headers[param.name] = strVal
    }
  }

  // Inject credential into request (ONLY here — never in result/log/URL-output)
  injectAuth(auth, secret, headers, queryParams)

  // Build body
  let body: string | undefined
  const bodyValue = args[bodyArgKey]
  if (bodyValue !== undefined && bodyValue !== null) {
    try {
      body = JSON.stringify(bodyValue)
    } catch (_cause) {
      return err<ToolResult, UpstreamError>({
        kind: "invalid-args",
        reason: "body is not JSON-serializable",
      })
    }
  } else if (methodLower !== "get" && methodLower !== "head" && methodLower !== "delete") {
    // No Content-Type for methods without body
    delete headers["Content-Type"]
  }

  // Build final URL (host is pinned; agent cannot override baseUrl)
  const queryString = queryParams.toString()
  // NOTE: we do NOT log or return this URL — it may contain an apiKey-in-query secret
  const fullUrl = `${baseUrl}${resolvedPath}${queryString ? `?${queryString}` : ""}`

  // Pre-flight URL validation — catch malformed URLs BEFORE fetch, so a TypeError carrying
  // the full URL (which may include an apiKey-in-query secret) never becomes an error cause.
  try {
    new URL(fullUrl)
  } catch {
    return err<ToolResult, UpstreamError>({
      kind: "call-failed",
      cause: "invalid request URL",
    })
  }

  // Execute with timeout and byte cap.
  // Timer stays armed through the FULL body read — not just until headers arrive —
  // to guard against a slowloris that sends headers instantly then dribbles the body.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(fullUrl, {
      method: methodLower.toUpperCase(),
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    })

    // Do NOT clearTimeout here — keep timer armed through the body read.

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
    // Check if aborted (timeout)
    if (
      cause !== null &&
      typeof cause === "object" &&
      "name" in cause &&
      (cause as { name: unknown }).name === "AbortError"
    ) {
      return err<ToolResult, UpstreamError>({ kind: "timed-out", ms: timeoutMs })
    }
    // SECURITY: do NOT use cause.message — a fetch TypeError may embed the full URL
    // which can contain an apiKey-in-query secret.
    return err<ToolResult, UpstreamError>({
      kind: "call-failed",
      cause: cause instanceof Error ? cause.constructor.name : "unknown",
    })
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// callOperation — main entry point (OpenAPI: resolves the operation from a
// parsed spec, then delegates to the shared buildAndExecuteRequest engine)
// ---------------------------------------------------------------------------

/**
 * Execute an OpenAPI operation by name with the given args.
 *
 * SECURITY: see `buildAndExecuteRequest` — this function only adds the
 * schema-specific half (find the operation, resolve the base URL, extract
 * the operation's raw `parameters` into the `BoundParam[]` shape).
 */
export function callOperation(
  schema: Record<string, unknown>,
  connection: OpenApiConnection,
  secret: string | null,
  operationName: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ResultAsync<ToolResult, UpstreamError> {
  return new ResultAsync(
    callOperationAsync(schema, connection, secret, operationName, args, timeoutMs),
  )
}

async function callOperationAsync(
  schema: Record<string, unknown>,
  connection: OpenApiConnection,
  secret: string | null,
  operationName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
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

  // Extract the operation's raw `parameters` into the schema-agnostic BoundParam[] shape.
  const rawParams = Array.isArray(operation.parameters) ? operation.parameters : []
  const params: BoundParam[] = []
  for (const p of rawParams) {
    if (p === null || typeof p !== "object") continue
    const param = p as OpenApiParameter
    if (typeof param.name !== "string") continue
    if (
      param.in !== "path" &&
      param.in !== "query" &&
      param.in !== "header" &&
      param.in !== "cookie"
    ) {
      continue
    }
    params.push({ name: param.name, in: param.in, required: param.required === true })
  }

  return buildAndExecuteRequest({
    baseUrl,
    method,
    pathTemplate: path,
    params,
    auth: connection.auth,
    secret,
    defaultHeaders: connection.defaultHeaders,
    args,
    timeoutMs,
    bodyArgKey: "body",
  })
}
