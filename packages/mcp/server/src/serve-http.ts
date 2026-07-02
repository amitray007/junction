// SPDX-License-Identifier: AGPL-3.0-only
/**
 * serveHttp — the shared, keyed `/mcp` HTTP endpoint (increment 27, §2.3).
 *
 * INJECTION BOUNDARY (load-bearing): mcp/server imports the SDK + @junction/core
 * TYPES ONLY. It NEVER imports repos, the credential store, or the DB. All
 * key/scope resolution is injected via two callbacks supplied by the cli
 * composition root (cli/commands/serve.ts):
 *
 *   authenticate(token) → ResultAsync<AuthedKey, ApiKeyError>
 *     Re-resolved on EVERY request (never cached) so revocation is immediate.
 *
 *   buildHandlers(authedKey) → McpServerHandlers
 *     Called ONCE per session, at `initialize` — the resulting handlers are
 *     frozen into the session's cache (§1 "live-reload parity": scope + proxies
 *     are snapshotted per session, not re-resolved on every tools/list).
 *
 * GUARD ORDER (fail-closed, all mandatory, BEFORE the SDK transport ever sees
 * the request — §2.3):
 *   1. Host guard    — loopback literals only (127.0.0.1[:port] / localhost[:port] / [::1][:port]).
 *   2. Origin guard  — ANY request bearing an Origin header → 403. This is OURS,
 *      not the SDK's: `allowedOrigins: []` is a verified no-op in the SDK source
 *      (webStandardStreamableHttp.js `length > 0` guard) and there is no SDK way
 *      to express "reject anything browser-originated" (a non-empty allowedOrigins
 *      list still lets Origin-less requests through, which is right for MCP
 *      clients but means the SDK config alone cannot enforce our policy).
 *   3. Body cap      — 1 MB; over-cap → 413, connection ended.
 *   4. Auth          — Bearer token → authenticate() → uniform 401 on ANY failure.
 *      Never echo or log the presented token.
 *
 * SESSION ↔ KEY BINDING (§2.3): a session's handlers are frozen at `initialize`
 * under the minting key. Every subsequent request on that session must present
 * (a) a currently-valid key AND (b) the SAME key that minted the session — a
 * different (even valid) key on a known session-id → 401 (fixation guard).
 * An unknown/stale session-id → 404 (lets clients auto-reinitialize).
 *
 * ERROR SANITIZATION: every /mcp error response reuses safeUpstreamMessage
 * discipline — no exception text, no stack, no SQL, no paths. Platform
 * credentials and junction keys never appear in any response, log, or error.
 */

import { randomUUID } from "node:crypto"
import type { IncomingMessage, Server as NodeHttpServer, ServerResponse } from "node:http"
import { createServer } from "node:http"
import type { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import type { McpServerHandlers } from "./server.js"
import { createMcpServer } from "./server.js"

// ---------------------------------------------------------------------------
// Public types — the injection boundary
// ---------------------------------------------------------------------------

/** The resolved identity of a validated junction API key (opaque to mcp/server). */
export interface AuthedKey {
  /** The key's public keyid — used for session-fixation binding + logging (never the secret). */
  keyId: string
}

/** Injected auth callback. Re-resolved on EVERY request — see module docs. */
export type AuthenticateFn = (token: string) => Promise<AuthedKeyResult>

export type AuthedKeyResult = { ok: true; key: AuthedKey } | { ok: false }

/** Injected handler-builder — called ONCE per session, at `initialize`. */
export type BuildHandlersFn = (authedKey: AuthedKey) => Promise<McpServerHandlers>

export interface ServeHttpOptions {
  port: number
  host?: string
  authenticate: AuthenticateFn
  buildHandlers: BuildHandlersFn
  /** Called after a successful auth decision — fire-and-forget bookkeeping (e.g. touchLastUsed). MUST NOT be awaited by the caller of this hook. */
  onAuthed?: (authedKey: AuthedKey) => void
  /** Optional structured logger — MUST NEVER receive a token or key secret. Defaults to console-free no-op logging via stderr-safe messages only when provided. */
  log?: (msg: string) => void
}

export interface ServeHttpHandle {
  server: NodeHttpServer
  port: number
  /** Gracefully close all live sessions + the HTTP server. */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Internal: session state
// ---------------------------------------------------------------------------

interface Session {
  transport: StreamableHTTPServerTransport
  mcpServer: McpSdkServer
  keyId: string
}

const MAX_BODY_BYTES = 1 * 1024 * 1024 // 1 MB

const HOST_ALLOW_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

// A valid-key holder is an in-scope attacker (§3 threat model): cap live sessions
// so a loop of `initialize` requests can't grow memory without bound. A single
// well-behaved agent uses one session; this ceiling is generous headroom.
const MAX_SESSIONS = 256

// Bound how long an unauthenticated/slow client can hold a connection before the
// full body is read (auth runs after the body cap, so pre-auth time must be capped).
const REQUEST_TIMEOUT_MS = 30_000
const HEADERS_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// serveHttp
// ---------------------------------------------------------------------------

/**
 * Start the shared, keyed `/mcp` HTTP endpoint.
 *
 * Binds `127.0.0.1:<port>` (or `opts.host` if given — callers should only
 * ever pass a loopback literal; the Host guard below enforces this on every
 * inbound request regardless of what we bind to). Resolves once listening;
 * rejects on EADDRINUSE / other listen errors so the caller can produce an
 * actionable CLI exit.
 */
export function serveHttp(opts: ServeHttpOptions): Promise<ServeHttpHandle> {
  const host = opts.host ?? "127.0.0.1"
  const sessions = new Map<string, Session>()
  const log = opts.log ?? (() => {})

  async function teardownSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId)
    if (session === undefined) return
    sessions.delete(sessionId)
    try {
      await session.transport.close()
    } catch {
      // best-effort teardown — nothing more we can do
    }
  }

  async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let total = 0
      let done = false

      const fail413 = () => {
        if (done) return
        done = true
        // Do NOT req.destroy() here — abruptly destroying the request stream
        // while the client is still writing races the socket teardown against
        // our response write and surfaces as an ECONNRESET on the client
        // instead of a clean 413. Instead: stop buffering (chunks already
        // dropped below), let the remaining bytes drain via the 'end'
        // listener's no-op (done guard), send 413 with Connection: close so
        // the socket is torn down cleanly AFTER the response flushes.
        if (!res.headersSent) {
          res.writeHead(413, { "content-type": "application/json", connection: "close" })
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "request body exceeds the 1 MB limit" },
              id: null,
            }),
          )
        }
        resolve(null)
      }

      req.on("data", (chunk: Buffer) => {
        if (done) {
          // Already failed — keep draining without buffering so the socket
          // can flush our response instead of backing up.
          return
        }
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          fail413()
          return
        }
        chunks.push(chunk)
      })
      req.on("end", () => {
        if (done) return
        done = true
        resolve(Buffer.concat(chunks))
      })
      req.on("error", () => {
        if (done) return
        done = true
        resolve(null)
      })
    })
  }

  function sendSanitizedError(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id: null,
      }),
    )
  }

  function extractBearerToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization
    if (typeof header !== "string") return null
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match) return null
    const token = match[1]
    return token === undefined || token === "" ? null : token
  }

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res)
  })
  // Bound pre-auth connection hold time (the body is read before auth, so a slow
  // client must not tie up a handler indefinitely). Node defaults are 300s/60s.
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`)

    if (url.pathname !== "/mcp") {
      sendSanitizedError(res, 404, "not found")
      return
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      sendSanitizedError(res, 404, "not found")
      return
    }

    // ── Guard 1: Host — loopback literals only ─────────────────────────────
    const hostHeader = req.headers.host
    if (typeof hostHeader !== "string" || !HOST_ALLOW_RE.test(hostHeader)) {
      sendSanitizedError(res, 403, "forbidden: invalid Host header")
      return
    }

    // ── Guard 2: Origin — ANY Origin header is rejected (ours, not the SDK's) ──
    if (req.headers.origin !== undefined) {
      sendSanitizedError(res, 403, "forbidden: browser-originated requests are not allowed")
      return
    }

    // ── Guard 3: body cap (only relevant for POST; GET/DELETE carry no body) ──
    let bodyBuf: Buffer | null = Buffer.alloc(0)
    if (req.method === "POST") {
      bodyBuf = await readBody(req, res)
      if (bodyBuf === null) return // readBody already sent 413
    }

    // ── Guard 4: auth — re-resolved on EVERY request ───────────────────────
    const token = extractBearerToken(req)
    if (token === null) {
      sendSanitizedError(res, 401, "invalid or revoked API key")
      return
    }
    const authResult = await opts.authenticate(token)
    if (!authResult.ok) {
      sendSanitizedError(res, 401, "invalid or revoked API key")
      return
    }
    const authedKey = authResult.key
    opts.onAuthed?.(authedKey) // fire-and-forget; caller owns not-awaiting semantics

    // ── Session dispatch ─────────────────────────────────────────────────
    const sessionIdHeader = req.headers["mcp-session-id"]
    const presentedSessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader

    let parsedBody: unknown
    if (req.method === "POST") {
      try {
        parsedBody = bodyBuf.length > 0 ? JSON.parse(bodyBuf.toString("utf8")) : undefined
      } catch {
        sendSanitizedError(res, 400, "invalid JSON")
        return
      }
    }

    if (presentedSessionId !== undefined) {
      const session = sessions.get(presentedSessionId)
      if (session === undefined) {
        // Unknown/stale session-id → 404 (lets clients auto-reinitialize, §2.3).
        sendSanitizedError(res, 404, "session not found")
        return
      }
      // Fixation guard: same session-id, DIFFERENT key → 401.
      if (session.keyId !== authedKey.keyId) {
        sendSanitizedError(res, 401, "invalid or revoked API key")
        return
      }
      try {
        await session.transport.handleRequest(req, res, parsedBody)
      } catch (cause) {
        log(`serve-http: transport error on session (sanitized): ${sanitize(cause)}`)
        sendSanitizedError(res, 500, "internal error")
      }
      return
    }

    // No session-id presented. Only a POST whose body is a genuine `initialize`
    // request legitimately starts a new session. A non-initialize POST (or
    // GET/DELETE) without a session-id must be rejected 400 BEFORE we do any
    // buildHandlers work or connect a transport — otherwise an authenticated
    // malformed POST would build+connect a transport the SDK then 400s, leaking
    // a connected transport with no cleanup path (never registered in `sessions`,
    // so onclose/close never reclaim it). Gating here closes that leak and the
    // scope-resolution work-amplification it enabled.
    if (req.method !== "POST" || !isInitializeRequest(parsedBody)) {
      sendSanitizedError(res, 400, "Mcp-Session-Id header is required")
      return
    }

    // Session cap: refuse to start a new session past the ceiling (§3 — a
    // valid-key local process must not exhaust memory by looping initialize).
    if (sessions.size >= MAX_SESSIONS) {
      sendSanitizedError(res, 429, "too many active sessions")
      return
    }

    // Build a brand-new session. Handlers are resolved ONCE here (frozen scope,
    // §1 "live-reload parity") — never re-resolved per tools/list.
    let handlers: McpServerHandlers
    try {
      handlers = await opts.buildHandlers(authedKey)
    } catch (cause) {
      log(`serve-http: buildHandlers failed (sanitized): ${sanitize(cause)}`)
      sendSanitizedError(res, 500, "internal error")
      return
    }

    const mcpServer = createMcpServer(undefined, handlers)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      // Mirror the app Host guard's admitted set so the two layers agree
      // (both loopback literals, with and without the bound port).
      allowedHosts: [
        `127.0.0.1:${opts.port}`,
        `localhost:${opts.port}`,
        `[::1]:${opts.port}`,
        "127.0.0.1",
        "localhost",
        "[::1]",
      ],
      // No allowedOrigins — our Origin guard (above) owns Origin rejection.
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, { transport, mcpServer, keyId: authedKey.keyId })
      },
      onsessionclosed: (sessionId: string) => {
        sessions.delete(sessionId)
      },
    })
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId)
    }

    try {
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res, parsedBody)
    } catch (cause) {
      log(`serve-http: transport error on new session (sanitized): ${sanitize(cause)}`)
      sendSanitizedError(res, 500, "internal error")
    }
  }

  return new Promise((resolve, reject) => {
    httpServer.once("error", (err: NodeJS.ErrnoException) => {
      reject(err)
    })
    httpServer.listen(opts.port, host, () => {
      resolve({
        server: httpServer,
        port: opts.port,
        async close() {
          await Promise.all([...sessions.keys()].map((id) => teardownSession(id)))
          await new Promise<void>((res2) => httpServer.close(() => res2()))
        },
      })
    })
  })
}

/** Sanitize an unknown error cause for log lines — never leak stack/paths/tokens. */
function sanitize(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
