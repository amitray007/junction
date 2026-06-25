// SPDX-License-Identifier: AGPL-3.0-only
// connectSource — build the right MCP transport from a McpConnection descriptor
// and an already-resolved secret, connect a Client, and return an UpstreamSession.
//
// SECRET DISCIPLINE (security-critical):
//   The secret is injected ONLY into the transport constructor (bearer header / env var).
//   It NEVER appears in argv, tool arguments, results, logs, error .cause, or stdout/stderr.
//   After transport construction the local reference is no longer held by this module.
//
// SOURCE-AGNOSTIC: zero vendor code. McpConnection is generic data; this file
// knows only transports (http / stdio), not platforms.

import type { McpConnection, UpstreamError } from "@junction/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { err, ok, ResultAsync } from "neverthrow"
import type { UpstreamSession } from "./session.js"
import { createSession, DEFAULT_TIMEOUT_MS } from "./session.js"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isEnoentError(cause: unknown): boolean {
  return cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT"
}

function isAuthError(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false
  if (
    "status" in cause &&
    (cause.status === 401 ||
      cause.status === 403 ||
      cause.status === "401" ||
      cause.status === "403")
  )
    return true
  if ("code" in cause && (cause.code === 401 || cause.code === 403)) return true
  if ("message" in cause && typeof cause.message === "string") {
    const msg = cause.message.toLowerCase()
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

function mapConnectError(
  cause: unknown,
  isStdio: boolean,
  command: string | undefined,
): UpstreamError {
  if (isStdio && isEnoentError(cause) && command !== undefined) {
    return { kind: "binary-not-found", command }
  }
  if (isAuthError(cause)) {
    return { kind: "auth-failed" }
  }
  return { kind: "connect-failed", cause }
}

// ---------------------------------------------------------------------------
// connectSource
// ---------------------------------------------------------------------------

/**
 * Connect to an upstream MCP source described by `connection` and return an
 * UpstreamSession whose tool names are all prefixed with `<toolNamespace>__`.
 *
 * The `secret` (bearer token / env-var value) is injected only into the
 * transport constructor and is never stored on the returned session or passed
 * through to any log or error.
 *
 * @param connection - Generic McpConnection descriptor (http | stdio).
 * @param toolNamespace - Namespace prefix applied to every upstream tool name.
 * @param secret - Resolved plaintext credential, or null if the source needs none.
 */
export function connectSource(
  connection: McpConnection,
  toolNamespace: string,
  secret: string | null,
): ResultAsync<UpstreamSession, UpstreamError> {
  const work = async () => {
    let transport: StreamableHTTPClientTransport | StdioClientTransport
    let isStdio = false
    let command: string | undefined

    if (connection.transport === "http") {
      // ── HTTP transport ───────────────────────────────────────────────────
      // SECRET injected ONLY into the header map. No other reference kept.
      const headers: Record<string, string> = {}
      if (connection.auth?.scheme === "bearer" && secret !== null) {
        const headerName = connection.auth.header ?? "Authorization"
        headers[headerName] = `Bearer ${secret}`
      }
      transport = new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers },
      })
    } else {
      // ── Stdio transport ──────────────────────────────────────────────────
      // VERIFIED GOTCHA (docs/futures/gotchas.md — MCP inc 11):
      // A custom `env` REPLACES the default environment. Spread
      // getDefaultEnvironment() (HOME,LOGNAME,PATH,SHELL,TERM,USER) first so
      // the child process can resolve binaries via PATH and authenticate via
      // HOME. Do NOT spread process.env — that would leak the full parent env
      // (including JUNCTION_MASTER_KEY and any other secrets).
      isStdio = true
      command = connection.command
      const env: Record<string, string> = {
        ...getDefaultEnvironment(),
        ...(connection.tokenEnvVar !== undefined && secret !== null
          ? { [connection.tokenEnvVar]: secret }
          : {}),
      }
      transport = new StdioClientTransport({
        command: connection.command,
        args: connection.args,
        env,
      })
    }

    // Connect the client (timeout-wrapped).
    const client = new Client({ name: "junction", version: "0.0.0" })

    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`connect timed out after ${DEFAULT_TIMEOUT_MS}ms`)),
            DEFAULT_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (cause) {
      const e = mapConnectError(cause, isStdio, command)
      // Map timeout during connect to timed-out
      if (cause instanceof Error && cause.message.startsWith("connect timed out")) {
        return err({ kind: "timed-out" as const, ms: DEFAULT_TIMEOUT_MS } satisfies UpstreamError)
      }
      return err(e)
    }

    // Secret is no longer referenced after this point — it exists only inside
    // the transport's header/env, which is garbage-collected with the transport.
    return ok(createSession(client, toolNamespace, () => client.close()))
  }

  return new ResultAsync(work())
}
