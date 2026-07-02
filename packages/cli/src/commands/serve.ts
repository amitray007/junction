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
  type CredentialStore,
  createCredentialStore,
  createProfileProxy,
  createRepositories,
  createScopedProxy,
  err,
  getDatabase,
  getMcpPort,
  getPaths,
  isValidMcpPort,
  ok,
  type Repositories,
  type Result,
  ResultAsync,
  type ScopedProxyEntry,
  type SourceRef,
  type ToolFilter,
  type ToolProvider,
  type UpstreamError,
  verifyApiKey,
} from "@junction/core"
import type { AuthedKey, AuthedKeyResult, McpServerHandlers } from "@junction/mcp-server"
import { defineCommand } from "citty"
import { consola } from "consola"
import { buildProvider } from "../providers.js"

// ---------------------------------------------------------------------------
// resolveProvider — identical shape/discipline to commands/mcp.ts.
// ---------------------------------------------------------------------------

type ProviderResolution = {
  provider: ToolProvider
  toolNamespace: string
  toolFilter?: ToolFilter | undefined
}

function makeResolveProvider(
  repos: Repositories,
  store: CredentialStore | null,
  paths: ReturnType<typeof getPaths>,
) {
  return (sourceRef: SourceRef): ResultAsync<ProviderResolution, UpstreamError> => {
    const work = async (): Promise<Result<ProviderResolution, UpstreamError>> => {
      const platformResult = await repos.platforms.get(sourceRef.platformId)
      if (platformResult.isErr()) {
        consola.warn(
          `junction serve: source "${sourceRef.toolNamespace}": platform "${sourceRef.platformId}" not found — skipping`,
        )
        return err({ kind: "connect-failed" as const, cause: platformResult.error })
      }
      const platform = platformResult.value

      if (platform.kind !== "mcp" && platform.kind !== "openapi") {
        consola.warn(
          `junction serve: source "${sourceRef.toolNamespace}": platform kind "${platform.kind}" not yet supported — skipping`,
        )
        return err({ kind: "unsupported-source-kind" as const, platformKind: platform.kind })
      }

      let secret: string | null = null
      if (sourceRef.credentialId === undefined) {
        const authDeclared =
          (platform.kind === "mcp" &&
            platform.connection !== undefined &&
            (platform.connection.transport === "http"
              ? platform.connection.auth !== undefined
              : platform.connection.tokenEnvVar !== undefined)) ||
          (platform.kind === "openapi" &&
            platform.openapi !== undefined &&
            platform.openapi.auth !== undefined)
        if (authDeclared) {
          consola.warn(
            `junction serve: source "${sourceRef.toolNamespace}": platform "${sourceRef.platformId}" declares auth but no credential is attached — calls may be unauthorized`,
          )
        }
      } else {
        const credResult = await repos.credentials.get(sourceRef.credentialId)
        if (credResult.isErr()) {
          consola.warn(
            `junction serve: source "${sourceRef.toolNamespace}": credential "${sourceRef.credentialId}" not found — skipping`,
          )
          return err({ kind: "connect-failed" as const, cause: credResult.error })
        }
        const credential = credResult.value
        if (store !== null) {
          const secretResult = await store.get(credential.secretRef)
          if (secretResult.isErr()) {
            consola.warn(
              `junction serve: source "${sourceRef.toolNamespace}": credential store read failed — skipping`,
            )
            return err({ kind: "connect-failed" as const, cause: secretResult.error })
          }
          secret = secretResult.value
        }
      }

      const providerResult = await buildProvider(platform, secret, paths)
      if (providerResult.isErr()) {
        const cause =
          "cause" in providerResult.error ? String(providerResult.error.cause ?? "") : ""
        consola.warn(
          `junction serve: source "${sourceRef.toolNamespace}": connection failed — skipping${cause ? ` (${cause})` : ""}`,
        )
        return err(providerResult.error)
      }

      return ok({
        provider: providerResult.value,
        toolNamespace: sourceRef.toolNamespace,
        toolFilter: sourceRef.toolFilter,
      })
    }
    return new ResultAsync(work())
  }
}

/** Adapt a core ScopedProxy (ResultAsync-based) to McpServerHandlers (Promise-based). */
function adaptToMcpHandlers(scoped: {
  listTools: () => ResultAsync<
    Array<{ name: string; description?: string; inputSchema: object }>,
    UpstreamError
  >
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => ResultAsync<{ content: unknown; isError?: boolean }, UpstreamError>
}): McpServerHandlers {
  return {
    async listTools() {
      const result = await scoped.listTools()
      if (result.isErr())
        return { tools: [] as Array<{ name: string; description?: string; inputSchema: object }> }
      return { tools: result.value }
    },
    async callTool(name: string, callArgs: Record<string, unknown>) {
      const result = await scoped.callTool(name, callArgs)
      if (result.isErr()) {
        const { safeUpstreamMessage } = await import("@junction/mcp-server")
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: safeUpstreamMessage(result.error) }],
        }
      }
      return {
        content: result.value.content as Array<{ type: "text"; text: string }>,
        isError: result.value.isError,
      }
    },
  }
}

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
    const resolveProvider = makeResolveProvider(repos, store, paths)

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
        const proxy = createProfileProxy(profile.sources, resolveProvider)
        entries.push({ profileName: profile.name, proxy })
      }

      const prefixed = record.scope !== "profile"
      const scoped = createScopedProxy(entries, prefixed)
      return adaptToMcpHandlers(scoped)
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
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        void handle.close().then(() => resolve())
      }
      process.once("SIGINT", shutdown)
      process.once("SIGTERM", shutdown)
    })
  },
})
