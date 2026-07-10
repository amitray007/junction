// SPDX-License-Identifier: AGPL-3.0-only
// UpstreamSession — wraps a connected MCP Client with RAW tool dispatch.
// createSession is exported so tests can inject a pre-connected Client
// (e.g. via InMemoryTransport) without going through transport construction.
//
// RAW NAMES (increment 14): listTools returns upstream tool names WITHOUT any
// namespace prefix. callTool accepts the RAW upstream name (no split/strip).
// Namespacing, ≤64-guard, and toolFilter now live in core/src/sources/proxy.ts.

import type { ProviderTool, ToolResult, UpstreamError } from "@junction/core"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { err, ok, type Result, ResultAsync } from "neverthrow"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UpstreamSession {
  /** Raw upstream tools (no namespace prefix). */
  listTools(): ResultAsync<ProviderTool[], UpstreamError>
  /** Call the upstream with the raw tool name (no namespace splitting). */
  callTool(rawName: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for use by connect.ts and tests)
// ---------------------------------------------------------------------------

/** Default call/connect timeout. Recorded in docs/futures/revisit-when.md. */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Response byte cap (32.13 Slice C) — mirrors openapi-client/http.ts and
 * graphql-client/http.ts's RESPONSE_BYTE_CAP (1 MB), the honest best-effort
 * mitigation available on this path.
 *
 * SDK INVESTIGATION (recorded here — no transport-level stream hook exists):
 * both transports the mcp-client uses (StdioClientTransport,
 * StreamableHTTPClientTransport) fully buffer a message BEFORE handing it to
 * `Client` — StdioClientTransport's `ReadBuffer.append` does an unconditional
 * `Buffer.concat` of every stdout chunk with no size limit until a newline is
 * found; StreamableHTTPClientTransport calls `response.json()` (buffers the
 * whole HTTP body) or pipes SSE frames through `EventSourceParserStream`
 * (also unbounded). Neither transport exposes a byte-count callback, a max-
 * size option, or a raw chunk hook — `Client.callTool()`/`listTools()` only
 * ever return the fully-parsed, fully-buffered result. There is no way to
 * abort mid-stream before the SDK itself has already allocated the full
 * buffer.
 *
 * RESIDUAL (the honest caveat): the guard below is a POST-PARSE size check —
 * by the time it runs, the SDK has already buffered the oversized payload in
 * memory once. This still bounds the damage (the check runs immediately after
 * the SDK's own await resolves, before the result is retained/forwarded
 * anywhere else in junction, and a single one-shot allocation that is
 * immediately discarded is a materially smaller risk than an UNBOUNDED
 * pass-through that keeps growing and gets forwarded/duplicated downstream).
 * A true pre-buffer abort would require a transport-level patch/fork of the
 * SDK — out of scope here; tracked in docs/futures/revisit-when.md.
 */
export const RESPONSE_BYTE_CAP = 1_048_576 // 1 MB

/** Best-effort byte size of an arbitrary MCP tool-call `content` value. */
function contentByteSize(content: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(content) ?? "", "utf8")
  } catch {
    // Non-serializable content (e.g. a circular structure) — treat as
    // "unmeasurable, assume oversized" rather than silently passing it
    // through uncapped.
    return Number.POSITIVE_INFINITY
  }
}

export class UpstreamTimeoutError extends Error {
  readonly ms: number
  constructor(ms: number) {
    super(`upstream timed out after ${ms}ms`)
    this.name = "UpstreamTimeoutError"
    this.ms = ms
  }
}

/** Wrap a promise with a timer that rejects after `ms`. The timer is cleared
 *  on both settle paths so it never leaks into the event loop. */
export function withTimeoutMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new UpstreamTimeoutError(ms))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export function isTimeoutError(e: unknown): e is UpstreamTimeoutError {
  return e instanceof UpstreamTimeoutError
}

function isAuthError(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false
  if (
    "status" in e &&
    (e.status === 401 || e.status === 403 || e.status === "401" || e.status === "403")
  )
    return true
  if ("code" in e && (e.code === 401 || e.code === 403)) return true
  if ("message" in e && typeof e.message === "string") {
    const msg = e.message.toLowerCase()
    if (
      msg.includes("unauthorized") ||
      msg.includes("forbidden") ||
      msg.includes("401") ||
      msg.includes("403")
    )
      return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

/**
 * Wrap a connected MCP Client in an UpstreamSession.
 *
 * Exported for testing: tests can inject a client connected via InMemoryTransport
 * without going through transport construction.
 * The `close` callback is called by `session.close()` (e.g. `() => client.close()`).
 *
 * RAW names: listTools returns raw upstream names; callTool takes a raw name
 * and passes it directly to the upstream (no split/strip).
 */
export function createSession(
  client: Client,
  closeFn: () => Promise<void>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): UpstreamSession {
  return {
    listTools(): ResultAsync<ProviderTool[], UpstreamError> {
      const work = async (): Promise<Result<ProviderTool[], UpstreamError>> => {
        try {
          const { tools } = await withTimeoutMs(client.listTools(), timeoutMs)
          return ok(
            tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: (t.inputSchema as object | undefined) ?? {},
            })),
          )
        } catch (cause) {
          if (isTimeoutError(cause)) {
            return err({ kind: "timed-out" as const, ms: cause.ms } satisfies UpstreamError)
          }
          return err({
            kind: "upstream-unavailable" as const,
            cause,
          } satisfies UpstreamError)
        }
      }
      return new ResultAsync(work())
    },

    callTool(
      rawName: string,
      args: Record<string, unknown>,
    ): ResultAsync<ToolResult, UpstreamError> {
      const work = async (): Promise<Result<ToolResult, UpstreamError>> => {
        try {
          const result = await withTimeoutMs(
            client.callTool({ name: rawName, arguments: args }),
            timeoutMs,
          )
          // Byte cap (32.13 Slice C) — see RESPONSE_BYTE_CAP's doc comment for
          // why this is a post-parse guard, not a stream-level abort: the SDK
          // gives no transport hook to cap earlier. Still the correct backstop
          // — a hostile/compromised MCP source returning a huge blob is
          // rejected here rather than silently forwarded through the proxy.
          if (contentByteSize(result.content) > RESPONSE_BYTE_CAP) {
            return err({
              kind: "response-too-large" as const,
              limit: RESPONSE_BYTE_CAP,
            } satisfies UpstreamError)
          }
          const isError =
            result.isError === true ? true : result.isError === false ? false : undefined
          return ok({ content: result.content, isError } satisfies ToolResult)
        } catch (cause) {
          if (isTimeoutError(cause)) {
            return err({ kind: "timed-out" as const, ms: cause.ms } satisfies UpstreamError)
          }
          if (isAuthError(cause)) {
            return err({ kind: "auth-failed" as const } satisfies UpstreamError)
          }
          return err({ kind: "call-failed" as const, cause } satisfies UpstreamError)
        }
      }
      return new ResultAsync(work())
    },

    async close(): Promise<void> {
      try {
        await closeFn()
      } catch {
        // best-effort close; swallow errors to avoid masking the caller's flow
      }
    },
  }
}
