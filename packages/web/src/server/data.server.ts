// SPDX-License-Identifier: AGPL-3.0-only
// Server-only data helpers — the ONLY file in @junction/web that imports @junction/core.
// Called exclusively from data.functions.ts createServerFn handlers.
// SECURITY: credentials output is metadata-only — no secret, no secretRef.

import {
  type AppAuth,
  type AppHelp,
  type AppSurface,
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
  listAllDesigns,
  listApps,
  listCatalogEntries,
  listProviders,
  loadConfig,
  loadConfigState,
  loadCustomDesigns,
  mergeDesigns,
  type Platform,
  type Repositories,
  resolveOAuthProviderId,
} from "@junction/core"
import { probeSurface, type ToolListResult } from "./probe.server.js"
import { getDb } from "./shared.server.js"

// Re-exported so client route/components can type-annotate AppDetail.app.help
// (increment 36) without a direct @junction/core import — same convention as
// this file's other own `export type` DTOs below. AppHelpSchema (catalog-
// schema.ts) is metadata-only: no secret/token/build-recipe field exists on
// it, so re-exporting the type carries no disclosure risk.
export type { AppHelp }

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
   * Increment 44 (Phase 3, R1) — the platform's OWN reference to a global
   * OAuth design id (`oauth/catalog.ts`'s `OAuthProvider.id`), when set. This
   * is the AUTHORITATIVE source of a platform's provider identity, fed to
   * `resolveOAuthProviderId` for grouping (readAppGroups) and surfaced by the
   * read-only OAuth-designs list. Metadata-only: a design-id reference,
   * validated at use-time (never a secret/token).
   */
  oauthProviderId?: string
  /**
   * Whether verify-on-add / test-connection can run a REAL check for this
   * platform (mcp/graphql → true; openapi → only when verifyOperationId is
   * set; cli → always false — running a command has side effects). See
   * source-runtime's verifyCredential "honesty matrix".
   */
  verifiable: boolean
}

/**
 * Whether verify-on-add/test-connection can run a real check for `p` (28.9
 * honesty matrix). Exported (increment 43) — platform-mutations.server.ts's
 * bindCredentialToPlatform reuses this EXACT gate to decide verifyThenBind
 * vs. confirmThenBind, mirroring connect.server.ts's `plan.verifiable`
 * branch. Keep this the single source of truth; do not fork a second copy.
 */
export function isVerifiable(p: Platform): boolean {
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
      ...(p.oauthProviderId !== undefined ? { oauthProviderId: p.oauthProviderId } : {}),
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
  /** Increment 42 — the credential's SOLE identity, shown everywhere. */
  name: string
  /** Increment 42 — null for an UNLINKED (standalone) credential. */
  platformId: string | null
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
   * OAuth-only metadata (increment 29) — token expiry (ISO string), the
   * first-class needsReauth state, and whether a refresh token is on file (a
   * BOOLEAN — never the ref value — so the badge can tell an auto-refreshable
   * credential from one that will need a manual reconnect). Absent for
   * non-oauth2 credentials. NEVER includes a token/ref value — see core's
   * OAuthMetaSchema (docs/rules/security.md refs-not-values).
   *
   * Increment 45, Slice E — `providerId` DROPPED from this shape: it was
   * never actually rendered anywhere in the web UI (grep confirms only
   * `needsReauth`/`hasRefreshToken`/`expiresAt` are consumed by
   * credentials.tsx / app.$id.tsx) — its sole purpose was feeding
   * `readAppGroups`'s now-removed `legacyProviderId` fallback argument. A
   * credential's OAuth design is sourced exclusively from its bound
   * platform's `oauthProviderId` (see `readPlatforms`' `PlatformMeta
   * .oauthProviderId`).
   */
  oauthState?: {
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
      name: c.name,
      platformId: c.platformId === null ? null : String(c.platformId),
      account: c.profileName,
      kind: c.kind,
      ...(c.lastVerifiedAt !== undefined ? { lastVerifiedAt: c.lastVerifiedAt } : {}),
      ...(c.lastVerifyResult !== undefined ? { lastVerifyResult: c.lastVerifyResult } : {}),
      ...(c.kind === "oauth2" && c.oauthMeta !== undefined
        ? {
            oauthState: {
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
// OAuth designs (increment 44, R1) — the READ-ONLY global "OAuth designs"
// surface in Settings. A richer projection of the SAME catalog than
// readOAuthProviders (which is scoped to the connect picker's needs): here we
// expose the endpoints + flow shape a human reads to understand a design, plus
// a join onto the platforms that currently reference each design.
//
// SECURITY: metadata-only. Every field is public catalog data — the
// authorization/token URLs are the provider's own public OAuth endpoints (the
// same ones registrationHint.docsUrl documents), NOT secrets. Client id/secret
// are entered per-credential at connect time and live only in the store; NONE
// of that is in the OAuthProvider catalog or reachable from here. `generic` is
// included and flagged as the escape-hatch template (empty endpoints — the
// user supplies concrete URLs per platform).
// ---------------------------------------------------------------------------

export type OAuthDesignMeta = {
  id: string
  displayName: string
  /** Provider's public authorization endpoint. Empty string for the `generic` template. */
  authorizationUrl: string
  /** Provider's public token endpoint. Empty string for the `generic` template. */
  tokenUrl: string
  pkce: "S256" | "plain" | "disabled"
  supportsRefresh: boolean
  /** registrationHint.docsUrl — where the user registers their own BYO client. Empty when none. */
  docsUrl: string
  /** True for the `generic` catalog entry — the bespoke-provider escape hatch (user-supplied URLs). */
  isTemplate: boolean
  /**
   * Increment 45 (Slice D) — true for a user-authored `custom:<slug>` design
   * (loaded from oauth-designs.json), false for a built-in catalog entry.
   * Drives the web/CLI list's built-in-vs-custom split and whether a Delete
   * action is offered (custom-only, D4).
   */
  isCustom: boolean
  /** Ids of the platforms that currently reference this design via platform.oauthProviderId. */
  referencedByPlatformIds: string[]
}

/**
 * The OAuth-designs list (built-ins + custom, increment 45 Slice D extends
 * the inc-44 built-ins-only read) + which platforms reference each design.
 * DB-backed (unlike readOAuthProviders) because it joins the pure catalog
 * against live platform rows (readPlatforms() — already metadata-only, now
 * carrying oauthProviderId). Degrades to zero references (empty arrays) if the
 * DB is unavailable, same graceful pattern as the other readers here.
 *
 * A custom-designs LOAD ERROR degrades to built-ins-only (mirrors
 * readAppGroups' degrade-not-fail choice, D1 doc comment) — this is a
 * READ surface, not the refresh path; the designs-store's own fail-closed
 * behavior still protects the resolver/refresh path independently.
 */
export async function readOAuthDesigns(): Promise<OAuthDesignMeta[]> {
  const [platforms, listedResult] = await Promise.all([readPlatforms(), listAllDesigns(getPaths())])

  if (listedResult.isErr()) {
    process.stderr.write(
      `readOAuthDesigns: custom OAuth designs store failed to load (${listedResult.error.kind === "store-error" ? listedResult.error.cause.kind : listedResult.error.kind}) — list degraded to built-ins only\n`,
    )
  }
  const listed = listedResult.isOk()
    ? listedResult.value
    : listProviders().map((p) => ({ ...p, isCustom: false }))

  // design id → referencing platform ids. A single pass over platforms.
  const referencesByDesign = new Map<string, string[]>()
  for (const p of platforms) {
    if (p.oauthProviderId === undefined) continue
    const list = referencesByDesign.get(p.oauthProviderId) ?? []
    list.push(p.id)
    referencesByDesign.set(p.oauthProviderId, list)
  }

  return listed.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    authorizationUrl: p.authorizationUrl,
    tokenUrl: p.tokenUrl,
    pkce: p.pkce,
    supportsRefresh: p.supportsRefresh,
    docsUrl: p.registrationHint.docsUrl,
    isTemplate: p.id === "generic",
    isCustom: p.isCustom,
    referencedByPlatformIds: referencesByDesign.get(p.id) ?? [],
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

/**
 * Web DTO for a catalog app on the /app index — an explicit field list (same
 * convention as audit.server.ts) so client-bound fields are opt-in, plus
 * `category`: the curated help.category labels (inc 30.13) that the legacy
 * listApps() projection drops (see core/src/apps/catalog.ts's
 * toAppDefinition). `auth` deliberately reuses core's AppAuth shape (a small,
 * public discriminated union) rather than redeclaring it. Metadata-only —
 * every field is public catalog data.
 */
export type AppMeta = {
  id: string
  displayName: string
  supportedKinds: string[]
  auth: AppAuth[]
  aliases?: string[]
  iconSlug?: string
  /** Curated category labels (may be several); absent/empty = uncategorized. */
  category?: string[]
}

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

  // Increment 45 (Slice A, D2) — load custom OAuth designs + merge with
  // built-ins so grouping can resolve a `custom:<slug>` platform reference
  // the SAME way refresh does (resolve-provider.ts). DELIBERATE CHOICE
  // (different from the refresh caller): grouping is DISPLAY-ONLY — it never
  // touches a token or decides whether a call is authorized — so a designs-
  // store LOAD ERROR here DEGRADES to built-ins-only rather than failing the
  // whole /app page. A connection bound to a now-unreadable custom design
  // just falls through resolveOAuthProviderId's dangling-reference path (same
  // as today) and appIdForConnection's later id/alias matching, same as any
  // other unresolvable oauthProviderId — never a hard failure for a read-only
  // surface. The error is logged so the degradation is diagnosable.
  const designsResult = await loadCustomDesigns(getPaths())
  if (designsResult.isErr()) {
    process.stderr.write(
      `readAppGroups: custom OAuth designs store failed to load (${designsResult.error.kind}) — grouping degraded to built-in designs only\n`,
    )
  }
  const designs = mergeDesigns(designsResult.isOk() ? designsResult.value : [])

  // Platform lookup — needed both to re-source the OAuth design (below) and to
  // re-attach connection metadata (further down). Built once, before grouping.
  const platformById = new Map(platforms.map((p) => [p.id, p]))

  // Core's groupByApp is pure and only needs {platformId, account, oauthProviderId}
  // per credential — resolve each credential's design id via the shared
  // resolver and map it onto the flat oauthProviderId field groupByApp
  // expects (review C2 — skipping this silently buckets every OAuth
  // connection into "other").
  const groupInput = {
    platforms: platforms.map((p) => ({
      id: p.id,
      kind: p.kind as Platform["kind"],
      displayName: p.displayName,
    })),
    // Increment 42 — an UNLINKED credential (platformId: null) has no
    // platform to group under an App; the /app surface is platform-scoped by
    // design, so it's excluded here (it shows up in the /credentials
    // "Unlinked" vault view instead).
    credentials: credentials
      .filter((c): c is typeof c & { platformId: string } => c.platformId !== null)
      .map((c) => {
        // Increment 44 (R3) — source the grouping provider id through the SAME
        // shared resolver refresh uses, so grouping and refresh can never
        // diverge on which OAuth design a connection belongs to. Increment 45,
        // Slice E — the credential's legacy `oauthMeta.providerId` fallback is
        // GONE: the platform's own `oauthProviderId` is now the ONLY source.
        // Grouping is display-only, so a `{ok:false}` (dangling design
        // reference, or no source at all) DEGRADES to "no hint" — the
        // connection simply falls through appIdForConnection's later
        // id/alias matching (never throws, never breaks the /app page).
        const resolved = resolveOAuthProviderId({
          credentialId: c.id,
          context: "group",
          platform: platformById.get(c.platformId),
          designs,
        })
        return {
          platformId: c.platformId,
          account: c.account,
          ...(resolved.ok ? { oauthProviderId: resolved.providerId } : {}),
        }
      }),
  }
  const groups = groupByApp(groupInput)

  // Lookups to re-attach full connection metadata: platform displayName/kind,
  // and (when the connection has a real credential) its status fields. A
  // credential-less connection (account === "—") has no CredentialMeta match.
  // (platformById is built above.)
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
  // Left-join help.category from the rich catalog: listApps()'s legacy
  // AppDefinition projection drops `help` entirely (see core catalog.ts),
  // so the Category facet would never see it otherwise. EXPLICIT field
  // mapping (no spread) so client-bound fields stay opt-in — a future core
  // AppDefinition field never rides along into the payload unreviewed.
  const categoryById = new Map(listCatalogEntries().map((e) => [e.id, e.help?.category]))
  const catalog: AppMeta[] = listApps().map((app) => {
    const category = categoryById.get(app.id)
    return {
      id: app.id,
      displayName: app.displayName,
      supportedKinds: app.supportedKinds,
      auth: app.auth,
      ...(app.aliases !== undefined ? { aliases: app.aliases } : {}),
      ...(app.iconSlug !== undefined ? { iconSlug: app.iconSlug } : {}),
      ...(category !== undefined ? { category } : {}),
    }
  })
  return { catalog, groups: groupMetas }
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

/**
 * Metadata-only "can this be one-click-connected" facet (increment 30.11) —
 * NEVER `build`/`connection` (the catalog recipe + secrets stay server-side;
 * see build-recipe.ts's ConnectPlanPreview, which the connect dialog fetches
 * separately once the user picks a mode). `authModes` mirrors `surface.auth`'s
 * modes; `verifiable` mirrors build-recipe.ts's isVerifiable(surface) rule
 * EXACTLY (duplicated here, not imported — that function is internal to
 * build-recipe.ts / Slice A, which this slice must not modify; the rule is a
 * one-line `surface.verify` check, low duplication risk).
 */
export type SurfaceConnectable = {
  authModes: AppAuth["mode"][]
  verifiable: boolean
}

export type SurfaceView = {
  kind: string
  displayName: string
  auth: AppAuth[]
  docs?: string
  agentGuidance?: string
  notes?: string[]
  state: "available" | "connected" | "serving"
  connections: SurfaceConnection[]
  /** Present only for a catalog-authored surface (never on the "other"/thin fallback). */
  connectable?: SurfaceConnectable
}

/**
 * Mirrors build-recipe.ts's isVerifiable(surface) — a surface is verifiable
 * iff its declared VerifyHint resolves to a real verify primitive on its
 * connection template. Kept in sync deliberately (see SurfaceConnectable's
 * doc comment); if a 3rd call site appears, promote to a shared export.
 */
function surfaceIsVerifiable(surface: AppSurface): boolean {
  const verify = surface.verify
  if (verify === undefined) return false
  switch (verify.kind) {
    case "openapi":
      return (
        surface.connection.kind === "openapi" && surface.connection.verifyOperationId !== undefined
      )
    case "mcp":
      return surface.connection.kind === "mcp"
    case "graphql":
      return surface.connection.kind === "graphql"
    case "none":
      return false
    default:
      return false
  }
}

export type AppDetail = {
  app: {
    id: string
    displayName: string
    iconSlug?: string
    help?: AppHelp
    authModes: AppAuth["mode"][]
  }
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
function thinAppDetail(
  id: string,
  displayName: string,
  authModes: AppAuth["mode"][],
  connections: ConnectionMeta[],
): AppDetail {
  return {
    app: { id, displayName, authModes },
    surfaces: [],
    otherConnections: connections,
  }
}

export async function readAppDetail(id: string): Promise<AppDetail> {
  const groups = await readAppGroups()
  const connections = groups.find((g) => g.appId === id)?.connections ?? []

  if (id === "other") {
    return thinAppDetail("other", "Other", [], connections)
  }

  const entry = getCatalogEntry(id)
  if (entry === undefined || entry.surfaces === undefined || entry.surfaces.length === 0) {
    return thinAppDetail(
      id,
      entry?.displayName ?? id,
      entry?.auth.map((a) => a.mode) ?? [],
      connections,
    )
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
        // Metadata-only connect facet (increment 30.11) — undefined only if
        // the catalog surface itself somehow can't be found (defensive; every
        // `kind` here came FROM entry.surfaces, so this is always defined in
        // practice), matching the optional field's contract.
        ...(surface !== undefined
          ? {
              connectable: {
                authModes: surface.auth.map((a) => a.mode),
                verifiable: surfaceIsVerifiable(surface),
              },
            }
          : {}),
      }
    }),
  )

  return {
    app: {
      id: entry.id,
      displayName: entry.displayName,
      ...(entry.iconSlug !== undefined ? { iconSlug: entry.iconSlug } : {}),
      ...(entry.help !== undefined ? { help: entry.help } : {}),
      authModes: entry.auth.map((a) => a.mode),
    },
    surfaces,
    otherConnections: leftover,
  }
}
