// SPDX-License-Identifier: AGPL-3.0-only
// Server-only data helpers — the ONLY file in @junction/web that imports @junction/core.
// Called exclusively from data.functions.ts createServerFn handlers.
// SECURITY: credentials output is metadata-only — no secret, no secretRef.

import {
  type AppAuth,
  type AppDefinition,
  type AppHelp,
  compatibleCredentialKinds,
  createCredentialStore,
  createRepositories,
  createSandbox,
  getCatalogEntry,
  getMcpHost,
  getMcpPort,
  getPaths,
  groupByApp,
  intersectSurfaces,
  type JunctionPaths,
  listApps,
  listProviders,
  loadConfig,
  loadConfigState,
  type Platform,
  type Repositories,
} from "@junction/core"
import { probeSurface, type ToolListResult } from "./probe.server.js"
import { getDb } from "./shared.server.js"

async function withRepos<T>(fallback: T, fn: (repos: Repositories) => Promise<T>): Promise<T> {
  const db = await getDb()
  if (db === null) return fallback
  return fn(createRepositories(db))
}

// ---------------------------------------------------------------------------
// Sandbox backend label — replicated from cli/src/commands/status.ts
// (resolveSandboxBackend), NOT imported (sibling app).
// ---------------------------------------------------------------------------

async function sandboxLabel(): Promise<string> {
  const result = await createSandbox()
  if (result.isErr()) return `unavailable (${result.error.kind})`
  const caps = result.value.capabilities()
  return `commands=${caps.command} · scripts=${caps.script}`
}

// ---------------------------------------------------------------------------
// Credential-store backend label.
// Replicated from cli/src/commands/status.ts — NOT imported (sibling app).
// ---------------------------------------------------------------------------

async function credentialStoreLabel(paths: JunctionPaths): Promise<string> {
  const result = await createCredentialStore(paths)
  if (result.isErr()) return `unavailable (${result.error.kind})`
  return result.value.backend === "keyring" ? "keyring" : "encrypted-file (auto-generated key)"
}

// ---------------------------------------------------------------------------
// System info — metadata only (Store / Sandbox / Home).
// Used by the sidebar panel; extracted so the sidebar server-fn does not
// pull in the full dashboard (counts + repos) on every page load.
// ---------------------------------------------------------------------------

export type SystemInfo = {
  credentialStore: string
  sandbox: string
  home: string
}

export async function readSystemInfo(): Promise<SystemInfo> {
  const paths = getPaths()
  const [credentialStore, sandbox] = await Promise.all([
    credentialStoreLabel(paths),
    sandboxLabel(),
  ])
  return { credentialStore, sandbox, home: paths.home }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export type DashboardData = {
  home: string
  initialized: boolean
  credentialStore: string
  sandbox: string
  counts: { platforms: number; credentials: number; profiles: number }
}

export async function readDashboard(): Promise<DashboardData> {
  const paths = getPaths()
  const [stateResult, systemInfo] = await Promise.all([loadConfigState(paths), readSystemInfo()])
  const initialized = stateResult.isOk() && stateResult.value.initialized

  const counts = await withRepos({ platforms: 0, credentials: 0, profiles: 0 }, async (repos) => {
    const [plat, cred, prof] = await Promise.all([
      repos.platforms.list(),
      repos.credentials.list(),
      repos.profiles.list(),
    ])
    return {
      platforms: plat.isOk() ? plat.value.length : 0,
      credentials: cred.isOk() ? cred.value.length : 0,
      profiles: prof.isOk() ? prof.value.length : 0,
    }
  })

  return {
    home: systemInfo.home,
    initialized,
    credentialStore: systemInfo.credentialStore,
    sandbox: systemInfo.sandbox,
    counts,
  }
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export type PlatformMeta = {
  id: string
  kind: string
  displayName: string
  baseUrl?: string
  /**
   * The CredentialKind(s) this platform accepts, derivation-ordered (first =
   * default), per core's compatibleCredentialKinds matrix (increment 28.9).
   * Empty array = no credential accepted (public/no-auth source).
   */
  compatibleKinds: string[]
  /**
   * Whether verify-on-add / test-connection can run a REAL check for this
   * platform (mcp/graphql → true; openapi → only when verifyOperationId is
   * set; cli → always false — running a command has side effects). See
   * source-runtime's verifyCredential "honesty matrix".
   */
  verifiable: boolean
}

/** Whether verify-on-add/test-connection can run a real check for `p` (28.9 honesty matrix). */
function isVerifiable(p: Platform): boolean {
  switch (p.kind) {
    case "mcp":
    case "graphql":
      return true
    case "openapi":
      return p.openapi?.verifyOperationId !== undefined
    case "cli":
    case "custom":
    case "http":
      // http: no operator-designated verify tool concept yet (mirrors
      // source-runtime's verifyCredential honesty matrix — never auto-picks a
      // declared request-tool to fire).
      return false
    default: {
      const _: never = p.kind
      return _
    }
  }
}

export async function readPlatforms(): Promise<PlatformMeta[]> {
  return withRepos<PlatformMeta[]>([], async (repos) => {
    const result = await repos.platforms.list()
    if (result.isErr()) return []
    return result.value.map((p) => ({
      id: String(p.id),
      kind: p.kind,
      displayName: p.displayName,
      ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
      compatibleKinds: compatibleCredentialKinds(p),
      verifiable: isVerifiable(p),
    }))
  })
}

// ---------------------------------------------------------------------------
// Credentials — metadata ONLY; NEVER secret or secretRef
// ---------------------------------------------------------------------------

export type CredentialMeta = {
  id: string
  platformId: string
  account: string
  kind: string
  /** Ms-epoch of the last verify-on-add/test-connection attempt. Absent = never verified. */
  lastVerifiedAt?: number
  /**
   * Outcome of the last verify attempt. Absent = never verified. "not-verifiable"
   * is NEVER a value here — it's a property of the platform, not a persisted
   * event (see core's CredentialVerifyResult / source-runtime's verifyCredential).
   */
  lastVerifyResult?: "ok" | "auth-failed" | "unreachable"
  /**
   * OAuth-only metadata (increment 29) — the catalog provider key, token
   * expiry (ISO string), the first-class needsReauth state, and whether a
   * refresh token is on file (a BOOLEAN — never the ref value — so the badge
   * can tell an auto-refreshable credential from one that will need a manual
   * reconnect). Absent for non-oauth2 credentials. NEVER includes a token/ref
   * value — see core's OAuthMetaSchema (docs/rules/security.md refs-not-values).
   */
  oauthState?: {
    providerId: string
    expiresAt: string | null
    needsReauth: boolean
    hasRefreshToken: boolean
  }
}

export async function readCredentials(): Promise<CredentialMeta[]> {
  return withRepos([], async (repos) => {
    const result = await repos.credentials.list()
    if (result.isErr()) return []
    // Map to metadata-only shape. NEVER include secret or secretRef.
    return result.value.map((c) => ({
      id: String(c.id),
      platformId: String(c.platformId),
      account: c.profileName,
      kind: c.kind,
      ...(c.lastVerifiedAt !== undefined ? { lastVerifiedAt: c.lastVerifiedAt } : {}),
      ...(c.lastVerifyResult !== undefined ? { lastVerifyResult: c.lastVerifyResult } : {}),
      ...(c.kind === "oauth2" && c.oauthMeta?.providerId !== undefined
        ? {
            oauthState: {
              providerId: c.oauthMeta.providerId,
              expiresAt: c.oauthMeta.expiresAt ?? null,
              needsReauth: c.oauthMeta.needsReauth ?? false,
              // boolean-only — presence of a refresh token, never the ref value
              hasRefreshToken: c.oauthMeta.refreshTokenRef !== undefined,
            },
          }
        : {}),
    }))
  })
}

// ---------------------------------------------------------------------------
// OAuth provider catalog — for the web Connect dialog's provider picker +
// guided-registration panel. The catalog itself is pure data (no secrets;
// registrationHint is intentionally public — it's the text junction shows the
// user to register their OWN BYO client), so this is a plain synchronous read,
// unlike the DB-backed reads above.
// ---------------------------------------------------------------------------

export type OAuthProviderMeta = {
  id: string
  displayName: string
  /** Presence in the catalog = device-code flow is offered; web only uses browser auth-code. */
  supportsDeviceCode: boolean
  redirectMode: "loopback-fixed" | "loopback-ephemeral"
  defaultScopes: string[]
  registrationHint: { redirectUri: string; scopes: string; docsUrl: string }
}

export function readOAuthProviders(): OAuthProviderMeta[] {
  return listProviders().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    supportsDeviceCode: p.deviceAuthorizationUrl !== undefined,
    redirectMode: p.redirectMode,
    defaultScopes: p.defaultScopes ?? [],
    registrationHint: p.registrationHint,
  }))
}

// ---------------------------------------------------------------------------
// Profiles with joined source metadata
// ---------------------------------------------------------------------------

export type SourceMeta = {
  namespace: string
  platform: string
  credentialAccount: string
  enabled: boolean
  toolFilter?: { allow?: string[]; deny?: string[] }
}

export type ProfileMeta = {
  id: string
  name: string
  sources: SourceMeta[]
}

// ---------------------------------------------------------------------------
// Settings — resolved MCP host + source
// ---------------------------------------------------------------------------

export type SettingsData = {
  /** The resolved MCP host (config value wins; falls to env; else undefined). */
  mcpHost: string | undefined
  /** Where the current value came from — drives the source note in the UI. */
  mcpHostSource: "config" | "env" | "none"
  /** The resolved MCP HTTP port (config > env > 4322 default) — always defined. */
  mcpPort: number
}

export async function readSettings(): Promise<SettingsData> {
  const paths = getPaths()
  // Resolve in parallel: the raw config (to see if mcpHost is explicitly set),
  // the fully-resolved host (config ?? env ?? undefined), and the resolved port.
  const [configResult, resolvedResult, portResult] = await Promise.all([
    loadConfig(paths),
    getMcpHost(paths),
    getMcpPort(paths),
  ])

  const rawConfigHost = configResult.isOk() ? configResult.value.mcpHost : undefined
  const resolved = resolvedResult.isOk() ? resolvedResult.value : undefined
  // getMcpPort falls back to DEFAULT_MCP_PORT (4322) internally on every branch —
  // isErr() only fires on a config read failure, which readSettings degrades from
  // gracefully rather than throwing (mirrors the mcpHost handling above).
  const mcpPort = portResult.isOk() ? portResult.value : 4322

  let mcpHostSource: SettingsData["mcpHostSource"] = "none"
  if (rawConfigHost !== undefined) {
    mcpHostSource = "config"
  } else if (resolved !== undefined) {
    // resolved but not from config → came from JUNCTION_MCP_HOST env
    mcpHostSource = "env"
  }

  return { mcpHost: resolved, mcpHostSource, mcpPort }
}

export async function readProfiles(): Promise<ProfileMeta[]> {
  return withRepos([], async (repos) => {
    const profilesResult = await repos.profiles.list()
    if (profilesResult.isErr()) return []

    // Collect all unique credential IDs across all profiles, then resolve them
    // in parallel (one Promise.all, not one await per source loop iteration).
    const allCredentialIds = new Set<string>()
    for (const profile of profilesResult.value) {
      for (const sr of profile.sources) {
        if (sr.credentialId !== undefined) allCredentialIds.add(String(sr.credentialId))
      }
    }

    // Batch-resolve all credentials referenced by any source.
    const credentialAccountMap = new Map<string, string>()
    await Promise.all(
      Array.from(allCredentialIds).map(async (id) => {
        const result = await repos.credentials.get(id)
        credentialAccountMap.set(id, result.isOk() ? result.value.profileName : "(unknown)")
      }),
    )

    return profilesResult.value.map((profile) => ({
      id: String(profile.id),
      name: profile.name,
      sources: profile.sources.map((sr) => {
        // No credentialId → public/no-auth source
        const credentialAccount =
          sr.credentialId !== undefined
            ? (credentialAccountMap.get(String(sr.credentialId)) ?? "(unknown)")
            : "(none)"
        return {
          namespace: sr.toolNamespace,
          platform: String(sr.platformId),
          credentialAccount,
          enabled: sr.enabled,
          ...(sr.toolFilter !== undefined ? { toolFilter: sr.toolFilter } : {}),
        }
      }),
    }))
  })
}

// ---------------------------------------------------------------------------
// Apps (increment 30) — the "connect a service" surface. The grouping is
// DERIVED live (no schema change, no persistence) from readPlatforms() +
// readCredentials() (already metadata-only) via core's pure groupByApp().
//
// DTO shape: {catalog, groups} — one reader, two facets of the same read.
// `catalog` is listApps() (the full App catalog — the /app index's spine,
// including apps with zero connections). `groups` is the live-derived
// per-app connection list (only apps/"other" that actually have ≥1
// connection are present — an unconnected catalog app is NOT in `groups`,
// by groupByApp's contract; the index left-joins catalog against groups).
//
// SECURITY: metadata-only, like readCredentials — NEVER a secret/secretRef.
// The per-connection status fields below are a SUBSET of CredentialMeta's
// verify/oauth fields, re-keyed onto the Connection shape.
// ---------------------------------------------------------------------------

export type AppMeta = AppDefinition

export type ConnectionMeta = {
  /** Underlying credential id — undefined for a credential-less (public) connection. */
  credentialId?: string
  account: string
  platformId: string
  platformDisplayName: string
  kind: string
  lastVerifiedAt?: number
  lastVerifyResult?: "ok" | "auth-failed" | "unreachable"
  oauthState?: {
    providerId: string
    expiresAt: string | null
    needsReauth: boolean
    hasRefreshToken: boolean
  }
}

export type AppGroupMeta = {
  appId: string
  connections: ConnectionMeta[]
}

export type AppsData = {
  catalog: AppMeta[]
  groups: AppGroupMeta[]
}

/**
 * Shared live-grouping step behind both readApps() (the /app index's light
 * spine) and readAppDetail() (the /app/:id rich surface view, increment
 * 30.10) — computes the derived AppGroupMeta[] once so the two readers don't
 * duplicate the platform/credential load + groupByApp + re-attach dance.
 */
async function readAppGroups(): Promise<AppGroupMeta[]> {
  const [platforms, credentials] = await Promise.all([readPlatforms(), readCredentials()])

  // Core's groupByApp is pure and only needs {platformId, account, oauthProviderId}
  // per credential — map CredentialMeta's nested oauthState.providerId onto the
  // flat oauthProviderId field groupByApp expects (review C2 — skipping this
  // silently buckets every OAuth connection into "other").
  const groupInput = {
    platforms: platforms.map((p) => ({
      id: p.id,
      kind: p.kind as Platform["kind"],
      displayName: p.displayName,
    })),
    credentials: credentials.map((c) => ({
      platformId: c.platformId,
      account: c.account,
      ...(c.oauthState?.providerId !== undefined
        ? { oauthProviderId: c.oauthState.providerId }
        : {}),
    })),
  }
  const groups = groupByApp(groupInput)

  // Lookups to re-attach full connection metadata: platform displayName/kind,
  // and (when the connection has a real credential) its status fields. A
  // credential-less connection (account === "—") has no CredentialMeta match.
  const platformById = new Map(platforms.map((p) => [p.id, p]))
  const credentialByPlatformAndAccount = new Map(
    credentials.map((c) => [`${c.platformId} ${c.account}`, c]),
  )

  return groups.map((group) => ({
    appId: group.appId,
    connections: group.connections.map((conn) => {
      const platform = platformById.get(conn.platformId)
      const credential =
        conn.account === "—"
          ? undefined
          : credentialByPlatformAndAccount.get(`${conn.platformId} ${conn.account}`)
      return {
        ...(credential !== undefined ? { credentialId: credential.id } : {}),
        account: conn.account,
        platformId: conn.platformId,
        platformDisplayName: platform?.displayName ?? conn.platformId,
        kind: conn.kind,
        ...(credential?.lastVerifiedAt !== undefined
          ? { lastVerifiedAt: credential.lastVerifiedAt }
          : {}),
        ...(credential?.lastVerifyResult !== undefined
          ? { lastVerifyResult: credential.lastVerifyResult }
          : {}),
        ...(credential?.oauthState !== undefined ? { oauthState: credential.oauthState } : {}),
      }
    }),
  }))
}

export async function readApps(): Promise<AppsData> {
  const groupMetas = await readAppGroups()
  return { catalog: listApps(), groups: groupMetas }
}

// ---------------------------------------------------------------------------
// App detail (increment 30.10) — the surface-first /app/:id capability view.
// Renders the RICH catalog entry (getCatalogEntry, surfaces + help) against
// this app's live connections + a per-connection tool probe. See
// docs/methods/30.10-surface-first-app-page.md.
//
// SurfaceView is a FRESH, metadata-only type — NEVER a re-export of core's
// AppSurface, which carries `connection`/`build` (secrets/build-recipe
// fields that must never reach the client). readApps()/getApps() (the /app
// index's light spine) are UNCHANGED by this addition.
// ---------------------------------------------------------------------------

export type SurfaceConnection = ConnectionMeta & { tools: ToolListResult }

export type SurfaceView = {
  kind: string
  displayName: string
  auth: AppAuth[]
  docs?: string
  agentGuidance?: string
  notes?: string[]
  state: "available" | "connected" | "serving"
  connections: SurfaceConnection[]
}

export type AppDetail = {
  app: { id: string; displayName: string; iconSlug?: string; help?: AppHelp }
  surfaces: SurfaceView[]
  otherConnections: ConnectionMeta[]
}

/**
 * Whether a connection counts as "healthy" for surface-state aggregation
 * (§2a truth table) — mirrors the route's connectionStatus() (app.$id.tsx):
 * healthy = "connected" or "expiring"; unhealthy = "auth-failed" /
 * "configured" / "no-auth". Duplicated rather than shared because
 * connectionStatus() lives in a client route component (UI-layer, computes
 * against `now` for rendering) — the rule-of-three isn't hit yet at 2 call
 * sites, and moving it into server code would blur the client/server
 * boundary for no real gain. Kept in sync deliberately; if a 3rd call site
 * appears, factor both into a shared pure predicate.
 */
function isHealthyConnection(conn: ConnectionMeta): boolean {
  if (conn.credentialId === undefined) return false // no-auth: public/credential-less
  if (conn.oauthState !== undefined) {
    if (conn.oauthState.needsReauth) return false // auth-failed
    return true // connected or expiring — both count as healthy here
  }
  return conn.lastVerifyResult === "ok" // connected; auth-failed/configured are not healthy
}

/** Thin fallback DTO for id==="other" / undefined-catalog / no-surfaces apps (§2 item 4). */
function thinAppDetail(id: string, displayName: string, connections: ConnectionMeta[]): AppDetail {
  return {
    app: { id, displayName },
    surfaces: [],
    otherConnections: connections,
  }
}

export async function readAppDetail(id: string): Promise<AppDetail> {
  const groups = await readAppGroups()
  const connections = groups.find((g) => g.appId === id)?.connections ?? []

  if (id === "other") {
    return thinAppDetail("other", "Other", connections)
  }

  const entry = getCatalogEntry(id)
  if (entry === undefined || entry.surfaces === undefined || entry.surfaces.length === 0) {
    return thinAppDetail(id, entry?.displayName ?? id, connections)
  }

  const { matched, leftover } = intersectSurfaces(entry.surfaces, connections)

  const surfaces: SurfaceView[] = await Promise.all(
    matched.map(async ({ kind, connections: surfaceConnections }) => {
      const surface = entry.surfaces?.find((s) => s.kind === kind)
      const surfaceConnectionsWithTools: SurfaceConnection[] = await Promise.all(
        surfaceConnections.map(async (conn) => ({
          ...conn,
          tools: await probeSurface({
            platformId: conn.platformId,
            credentialId: conn.credentialId,
          }),
        })),
      )

      // "serving" requires the SAME connection to be both healthy AND
      // probed-with-tools (§2a) — NOT independent any/any scans (a healthy
      // connection A with 0 tools + an unhealthy connection B with tools
      // must NOT read as "serving"; review fix).
      const anyServing = surfaceConnectionsWithTools.some(
        (c) => isHealthyConnection(c) && c.tools.status === "ok" && c.tools.tools.length > 0,
      )

      let state: SurfaceView["state"]
      if (surfaceConnectionsWithTools.length === 0) {
        state = "available"
      } else if (anyServing) {
        state = "serving"
      } else {
        state = "connected"
      }

      return {
        kind,
        displayName: surface?.displayName ?? kind,
        auth: surface?.auth ?? [],
        ...(surface?.docs !== undefined ? { docs: surface.docs } : {}),
        ...(surface?.agentGuidance !== undefined ? { agentGuidance: surface.agentGuidance } : {}),
        ...(surface?.notes !== undefined ? { notes: surface.notes } : {}),
        state,
        connections: surfaceConnectionsWithTools,
      }
    }),
  )

  return {
    app: {
      id: entry.id,
      displayName: entry.displayName,
      ...(entry.iconSlug !== undefined ? { iconSlug: entry.iconSlug } : {}),
      ...(entry.help !== undefined ? { help: entry.help } : {}),
    },
    surfaces,
    otherConnections: leftover,
  }
}
