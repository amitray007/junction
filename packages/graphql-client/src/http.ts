// SPDX-License-Identifier: AGPL-3.0-only
// http.ts — execute a single GraphQL operation as an HTTP POST.
// SECURITY-CRITICAL: credential injected ONLY into the HTTP request.
// No secret in tool results, errors, logs, or URLs surfaced anywhere.
// SOURCE-AGNOSTIC: no vendor-specific code.
//
// NOTE: The HTTP discipline (RESPONSE_BYTE_CAP, slowloris guard, redirect:"manual",
// leak-safe errors from cause.constructor.name) is deliberately duplicated from
// openapi-client/http.ts — this is the legitimate 2nd use (rule of three).
// Do NOT extract a shared helper until a 3rd HTTP provider appears.
// See docs/futures/revisit-when.md for the trigger.

import type { GraphQlConnection, OpenApiAuth, ToolResult, UpstreamError } from "@junction/core"
import { err, ok, ResultAsync } from "neverthrow"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30_000
export const RESPONSE_BYTE_CAP = 1_048_576 // 1 MB

// ---------------------------------------------------------------------------
// Credential injection — mirrors openapi-client injectAuth
// ---------------------------------------------------------------------------

/**
 * Inject auth credential into request headers.
 *
 * SECURITY: The secret never appears in logs, error messages, or returned output.
 * Credential is header-injected ONLY — never spliced into the query document.
 */
/* jscpd:ignore-start — injectAuth signatures differ: openapi-client takes queryParams (apiKey-in-query); graphql-client does not (single POST endpoint, query params not meaningful) */
function injectAuth(
  auth: OpenApiAuth | undefined,
  secret: string | null,
  headers: Record<string, string>,
): void {
  if (!auth || secret === null) return

  switch (auth.scheme) {
    case "apiKey":
      if (auth.in === "header") {
        headers[auth.name] = secret
      } else if (auth.in === "query") {
        // Unreachable: `platform add --kind graphql` rejects apiKey-in-query at
        // add-time (meaningless for a single POST endpoint). No-op defensive
        // backstop so a hand-edited descriptor can never splice the key into the URL.
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
/* jscpd:ignore-end */

// ---------------------------------------------------------------------------
// GraphQL request body
// ---------------------------------------------------------------------------

interface GraphQlRequestBody {
  query: string
  variables?: Record<string, unknown>
  operationName?: string
}

// ---------------------------------------------------------------------------
// callGraphQl — main entry point
// ---------------------------------------------------------------------------

/**
 * Execute a GraphQL operation via HTTP POST.
 *
 * SECURITY:
 * - Secret injected ONLY into HTTP request headers — never in the query document.
 * - Endpoint URL NEVER surfaced in errors/logs (leak-safe: cause.constructor.name).
 * - 1 MB response cap + 30s timeout (slowloris guard: timer stays armed through body read).
 * - redirect:"manual" prevents SSRF via redirect to internal endpoints.
 *
 * Error/data rules:
 * - Non-200 HTTP → typed UpstreamError (call-failed / timed-out / response-too-large).
 * - HTTP 200 with { errors, data:null } → isError:true (partial data → isError:false).
 * - The upstream `errors` array IS returned verbatim — it is agent signal, not a secret.
 */
export function callGraphQl(
  connection: GraphQlConnection,
  secret: string | null,
  query: string,
  variables: Record<string, unknown> | undefined,
  operationName: string | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ResultAsync<ToolResult, UpstreamError> {
  return new ResultAsync(
    callGraphQlAsync(connection, secret, query, variables, operationName, timeoutMs),
  )
}

async function callGraphQlAsync(
  connection: GraphQlConnection,
  secret: string | null,
  query: string,
  variables: Record<string, unknown> | undefined,
  operationName: string | undefined,
  timeoutMs: number,
): Promise<import("neverthrow").Result<ToolResult, UpstreamError>> {
  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/graphql-response+json, application/json",
    ...(connection.defaultHeaders ?? {}),
  }

  // Inject credential (ONLY here — never in result/log/error)
  injectAuth(connection.auth, secret, headers)

  // Build body — omit undefined fields
  const body: GraphQlRequestBody = { query }
  if (variables !== undefined) body.variables = variables
  if (operationName !== undefined && operationName !== "") body.operationName = operationName

  let bodyStr: string
  try {
    bodyStr = JSON.stringify(body)
  } catch (_cause) {
    return err<ToolResult, UpstreamError>({
      kind: "invalid-args",
      reason: "request body is not JSON-serializable",
    })
  }

  // Pre-flight URL validation — catch malformed endpoint BEFORE fetch so a TypeError
  // carrying the full URL (which may include secrets) never becomes an error cause.
  try {
    new URL(connection.endpoint)
  } catch {
    return err<ToolResult, UpstreamError>({
      kind: "call-failed",
      cause: "invalid endpoint URL",
    })
  }

  // Execute with timeout and byte cap.
  // Timer stays armed through the FULL body read — not just until headers arrive —
  // to guard against a slowloris that sends headers instantly then dribbles the body.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(connection.endpoint, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
      redirect: "manual",
    })

    // Do NOT clearTimeout here — keep timer armed through the body read.

    // Stream response with byte cap
    const reader = res.body?.getReader()
    if (!reader) {
      // Fallback: res.body absent (rare)
      const text = await res.text()
      if (!res.ok) {
        return err<ToolResult, UpstreamError>({
          kind: "call-failed",
          cause: `HTTP ${res.status}`,
        })
      }
      return ok<ToolResult, UpstreamError>({
        content: [{ type: "text", text }],
        isError: false,
      })
    }

    /* jscpd:ignore-start — streaming body-read loop is shared mechanics (2nd use; rule of three not yet tripped).
       Executor functions differ: graphql applies isError rule + status-line format;
       openapi-client returns status+body verbatim. Extraction deferred until a 3rd consumer. */
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
    /* jscpd:ignore-end */

    const bodyText = Buffer.concat(chunks).toString("utf8")

    // Non-200: surface as typed error (scrubbed — no endpoint/token)
    if (!res.ok) {
      return err<ToolResult, UpstreamError>({
        kind: "call-failed",
        cause: `HTTP ${res.status}`,
      })
    }

    // GraphQL 200 — parse to apply the data/errors isError rule.
    // The upstream `errors` array IS returned (agent's signal, not a secret).
    let parsed: { data?: unknown; errors?: unknown[] } | null = null
    try {
      parsed = JSON.parse(bodyText) as { data?: unknown; errors?: unknown[] }
    } catch {
      // Unparseable 200 body — return as-is; isError:false (HTTP said OK)
    }

    // isError:true only when errors present AND data is null/absent (partial → false)
    const hasErrors = Array.isArray(parsed?.errors) && parsed.errors.length > 0
    const hasData =
      parsed !== null && "data" in parsed && parsed.data !== null && parsed.data !== undefined
    const isError = hasErrors && !hasData

    return ok<ToolResult, UpstreamError>({
      content: [{ type: "text", text: bodyText }],
      isError,
    })
    /* jscpd:ignore-start — catch block is shared mechanics (AbortError detection + scrubbed call-failed);
     deferred to core until a 3rd consumer. */
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
    // which can contain a secret (e.g. apiKey-in-query, though we prefer headers).
    return err<ToolResult, UpstreamError>({
      kind: "call-failed",
      cause: cause instanceof Error ? cause.constructor.name : "unknown",
    })
    /* jscpd:ignore-end */
  } finally {
    clearTimeout(timer)
  }
}
