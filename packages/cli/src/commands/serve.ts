// SPDX-License-Identifier: AGPL-3.0-only
// `junction serve` — long-running HTTP MCP endpoint at /mcp (increment 27).
//
// NOT the stdio MCP channel: this command's stdout is free to log normally
// (the stdio-serve stdout-purity constraint in commands/mcp.ts does NOT apply
// here — there is no MCP-over-stdio session on this process's stdio).
//
// ARCHITECTURE — composition root (injection), mirrors commands/mcp.ts:
//   mcp/server (serveHttp) NEVER imports repos/store/DB. This file builds:
//     authenticate(token)      — verifyApiKey against the DB, RE-RESOLVED per request
//     buildHandlers(authedKey) — resolve scope → per-profile proxies → ScopedProxy
//   and injects both into serveHttp.
//
// CREDENTIAL DISCIPLINE: identical to commands/mcp.ts's resolveProvider — the
// platform secret is fetched per-call and never logged/returned. Additionally
// here: the junction API key token is NEVER logged (the authenticate callback
// only ever returns { ok, key: { keyId } } — never the token or hash).
//
// touchLastUsed (repo bookkeeping) is fire-and-forget: called AFTER the auth
// decision is already computed, its ResultAsync is intentionally NOT awaited
// in the request path and its Err is swallowed via .then(() => {}, () => {})
// — a slow/failing write must never delay or fail auth (§2.1 / repo doc).

import {
  type AuditPrincipal,
  createCredentialStore,
  createFileToolPinStore,
  createProfileProxy,
  createRepositories,
  createScopedProxy,
  ensureHome,
  getDatabase,
  getMcpPort,
  getPaths,
  isValidMcpPort,
  rotateAuditLogIfOversized,
  type ScopedProxyEntry,
  sweepStaleCredDirs,
  verifyApiKey,
} from "@junction/core"
import type { AuthedKey, AuthedKeyResult, McpServerHandlers } from "@junction/mcp-server"
import { makeResolveProvider } from "@junction/source-runtime"
import { defineCommand } from "citty"
import { consola } from "consola"
import { createFileAuditSink } from "../audit-sink.js"
import { adaptToMcpHandlers } from "../providers.js"

// ---------------------------------------------------------------------------
// serve command
// ---------------------------------------------------------------------------

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Serve the shared, keyed HTTP MCP endpoint at http://127.0.0.1:<port>/mcp.",
  },
  args: {
    port: {
      type: "string",
      description: "Port to listen on (default: config.mcpPort > JUNCTION_MCP_PORT env > 4322)",
      default: "",
    },
  },
  async run({ args }) {
    const { serveHttp } = await import("@junction/mcp-server")

    const paths = getPaths()

    // ── Port precedence: --port flag > getMcpPort() (config > env > 4322) ──
    let port: number
    if (args.port !== "" && args.port !== undefined) {
      const parsed = Number(args.port)
      if (!isValidMcpPort(parsed)) {
        consola.error(`junction serve: invalid --port "${args.port}" (expected an integer 1-65535)`)
        process.exitCode = 1
        return
      }
      port = parsed
    } else {
      const portResult = await getMcpPort(paths)
      if (portResult.isErr()) {
        consola.error(`junction serve: failed to resolve port (${portResult.error.kind})`)
        process.exitCode = 1
        return
      }
      port = portResult.value
    }

    // ── Ensure the home dir exists at 0700 (defense-in-depth, increment 32.1) ─
    // `init` is the only other caller of ensureHome(); a serve-first home
    // (no prior `junction init`) would otherwise get its dir mkdir'd with no
    // mode by getDatabase, landing at the umask default (often 0755).
    const homeResult = await ensureHome()
    if (homeResult.isErr()) {
      consola.error(`junction serve: failed to create home dir (${homeResult.error.kind})`)
      process.exitCode = 1
      return
    }

    // Fire-and-forget: sweep any stale (>1h) cred-* temp dirs stranded by a
    // hard kill mid-materialization (increment 32.7 item 2). Never awaited
    // into the startup path, never fails it.
    void sweepStaleCredDirs(paths).catch(() => {})

    // ── Open the DB (required — keys/profiles both live there) ─────────────
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) {
      consola.error(`junction serve: database error (${dbResult.error.kind})`)
      process.exitCode = 1
      return
    }
    const db = dbResult.value
    const repos = createRepositories(db)

    // ── Open the credential store (best-effort — mirrors commands/mcp.ts) ──
    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) {
      consola.warn(
        `junction serve: credential store unavailable (${storeResult.error.kind}), all sources will be skipped`,
      )
    }
    const store = storeResult.isOk() ? storeResult.value : null
    const resolveProvider = makeResolveProvider(repos, store, paths, {
      logPrefix: "junction serve",
      log: (msg: string) => consola.warn(msg),
    })

    // Hash-pinning / rug-pull detection (increment 32.11): ONE file-backed pin store for
    // this process, injected into every buildHandlers() call's per-profile proxies below —
    // mirrors auditSink's one-per-process construction.
    const toolPinStore = createFileToolPinStore(paths)

    // Rotate BEFORE the sink opens its fd (increment 32.8) — see rotate.ts's
    // header for the rotate-before-open design rationale. A rotation failure
    // never blocks startup; it's just a warn in this file's own idiom.
    const rotate = await rotateAuditLogIfOversized(paths.auditLogFile)
    if (rotate.kind === "failed") {
      consola.warn(`junction serve: audit-log rotation failed (${rotate.code}), continuing`)
    }

    // Audit sink (increment 31 Slice B): one pino-backed file sink per
    // process, injected into every buildHandlers() call this session.
    const auditSink = createFileAuditSink(paths)

    // ── authenticate: verifyApiKey, RE-RESOLVED on every request ───────────
    const authenticate = async (token: string): Promise<AuthedKeyResult> => {
      const result = await verifyApiKey(token, repos.apiKeys)
      if (result.isErr()) return { ok: false }
      const resolved = result.value
      const authedKey: AuthedKey = { keyId: resolved.keyId }
      // Fire-and-forget bookkeeping AFTER the auth decision — never awaited,
      // Err swallowed. A slow/failing write must never delay or fail auth.
      void repos.apiKeys.touchLastUsed(resolved.keyId).then(
        () => {},
        () => {},
      )
      return { ok: true, key: authedKey }
    }

    // ── buildHandlers: resolve scope → per-profile proxies → ScopedProxy ───
    const buildHandlers = async (authedKey: AuthedKey): Promise<McpServerHandlers> => {
      // Re-resolve the full ResolvedKey (scope + profileIds) for this authed key.
      // authenticate() above already proved the token is valid for this keyId;
      // buildHandlers only needs the key row's scope/profileIds, which is a
      // pure DB read (no secret involved) — fetch by keyId directly.
      const recordResult = await repos.apiKeys.getByKeyId(authedKey.keyId)
      if (recordResult.isErr()) {
        // No attribution possible (the key row itself didn't resolve) — keep
        // audit OFF rather than emit a line with no label/scope to attribute.
        return adaptToMcpHandlers(createScopedProxy([], false))
      }
      const record = recordResult.value

      // GLOBAL SCOPE (§2.2: api_key_profiles has ZERO rows for 'global' —
      // that's not the scope, it's the absence of a fixed join). A global
      // key's tool set is ALL profiles, resolved live every session so it
      // "grows gracefully as profiles are added" (§1 decision #4). Snapshot
      // happens once per session (at this buildHandlers call), matching the
      // live-reload-parity convention — not re-resolved per tools/list.
      let profileIds: string[]
      if (record.scope === "global") {
        const allProfilesResult = await repos.profiles.list()
        profileIds = allProfilesResult.isOk() ? allProfilesResult.value.map((p) => p.id) : []
      } else {
        const scopeIdsResult = await repos.apiKeys.getScopeProfileIds(record.id)
        profileIds = scopeIdsResult.isOk() ? scopeIdsResult.value : []
      }

      // Failure boundary (§2.3): a missing profile ROW is simply absent
      // (fail-safe shrink — the join row cascade already removed it, or a
      // transient race reads as absent). Never brick the whole session. A
      // profile that loads but whose SOURCE fails to resolve degrades
      // per-source exactly like stdio (createProfileProxy's own resilience).
      const entries: ScopedProxyEntry[] = []
      for (const profileId of profileIds) {
        const profileResult = await repos.profiles.get(profileId)
        if (profileResult.isErr()) continue // absent → skip, fail-safe shrink
        const profile = profileResult.value
        // Tool-poisoning mitigation (increment 32.5) + hash-pinning / rug-pull detection
        // (increment 32.11): sanitize and TOFU pin-comparison are always applied inside
        // createProfileProxy; onDescriptionDrift only SURFACES either signal, discriminated
        // by info.reason ("sanitized" | "pin-drift") — one structured warn, metadata only,
        // never the (possibly-injected) description text, never old/new hashes.
        const proxy = createProfileProxy(
          profile.sources,
          resolveProvider,
          (info) => {
            consola.warn({
              event: info.reason === "pin-drift" ? "tool_pin_drift" : "description_sanitized",
              namespace: info.namespace,
              tool: info.tool,
              strippedSuspicious: info.strippedSuspicious,
              truncated: info.truncated,
              reason: info.reason,
            })
          },
          toolPinStore,
        )
        entries.push({ profileName: profile.name, proxy })
      }

      const prefixed = record.scope !== "profile"
      const scoped = createScopedProxy(entries, prefixed)

      const principal: AuditPrincipal = {
        kind: "api-key",
        keyId: authedKey.keyId,
        label: record.label,
        profiles: entries.map((e) => e.profileName),
      }
      return adaptToMcpHandlers(scoped, { principal, sink: auditSink, prefixed })
    }

    // ── Start the HTTP endpoint ──────────────────────────────────────────
    let handle: Awaited<ReturnType<typeof serveHttp>>
    try {
      handle = await serveHttp({
        port,
        authenticate,
        buildHandlers,
        log: (msg: string) => consola.warn(msg),
      })
    } catch (cause: unknown) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code
      if (code === "EADDRINUSE") {
        consola.error(
          `junction serve: port ${port} in use — is another 'junction serve' running? use --port`,
        )
      } else {
        consola.error(
          `junction serve: failed to start (${String((cause as Error)?.message ?? cause)})`,
        )
      }
      process.exitCode = 1
      return
    }

    consola.success(`junction serve: listening on http://127.0.0.1:${port}/mcp`)

    // ── Graceful shutdown ────────────────────────────────────────────────
    // Flush the audit sink on every clean-shutdown signal; process "exit" is
    // the belt-and-suspenders backstop for any other clean-exit path.
    process.on("exit", () => auditSink.flushSync())
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        auditSink.flush()
        void handle.close().then(() => resolve())
      }
      process.once("SIGINT", shutdown)
      process.once("SIGTERM", shutdown)
    })
  },
})
