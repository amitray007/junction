// SPDX-License-Identifier: AGPL-3.0-only
// UpstreamSession — wraps a connected MCP Client with namespaced tool dispatch.
// createSession is exported so tests can inject a pre-connected Client
// (e.g. via InMemoryTransport) without going through transport construction.

import type { UpstreamError } from "@junction/core"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { err, ok, type Result, ResultAsync } from "neverthrow"
import { namespaceToolName, splitNamespacedName } from "./helpers.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NamespacedTool {
  name: string
  description?: string | undefined
  inputSchema: object
}

export interface ToolResult {
  content: unknown
  isError?: boolean | undefined
}

export interface UpstreamSession {
  /** Upstream tools, each name prefixed with `<namespace>__`. */
  listTools(): ResultAsync<NamespacedTool[], UpstreamError>
  /** Call a `<namespace>__<tool>` — strips the prefix, routes upstream. */
  callTool(name: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Default call/connect timeout. Recorded in docs/futures/revisit-when.md. */
export const DEFAULT_TIMEOUT_MS = 30_000

class UpstreamTimeoutError extends Error {
  readonly ms: number
  constructor(ms: number) {
    super(`upstream timed out after ${ms}ms`)
    this.name = "UpstreamTimeoutError"
    this.ms = ms
  }
}

function withTimeoutMs<T>(promise: Promise<T>, ms: number): Promise<T> {
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

function isTimeoutError(e: unknown): e is UpstreamTimeoutError {
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
 */
export function createSession(
  client: Client,
  toolNamespace: string,
  closeFn: () => Promise<void>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): UpstreamSession {
  return {
    listTools(): ResultAsync<NamespacedTool[], UpstreamError> {
      const work = async (): Promise<Result<NamespacedTool[], UpstreamError>> => {
        try {
          const { tools } = await withTimeoutMs(client.listTools(), timeoutMs)
          const result: NamespacedTool[] = []
          for (const t of tools) {
            const nameResult = namespaceToolName(toolNamespace, t.name)
            if (nameResult.isErr()) return err(nameResult.error)
            result.push({
              name: nameResult.value,
              description: t.description,
              inputSchema: (t.inputSchema as object | undefined) ?? {},
            })
          }
          return ok(result)
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

    callTool(name: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError> {
      const work = async (): Promise<Result<ToolResult, UpstreamError>> => {
        const { namespace, tool } = splitNamespacedName(name)
        if (namespace !== toolNamespace || !tool) {
          return err({ kind: "tool-not-found" as const, name } satisfies UpstreamError)
        }
        try {
          const result = await withTimeoutMs(
            client.callTool({ name: tool, arguments: args }),
            timeoutMs,
          )
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
