// SPDX-License-Identifier: AGPL-3.0-only
// Server-only data helpers — the ONLY file in @junction/web that imports @junction/core.
// Called exclusively from data.functions.ts createServerFn handlers.
// SECURITY: credentials output is metadata-only — no secret, no secretRef.

import {
  createCredentialStore,
  createRepositories,
  createSandbox,
  type Db,
  getDatabase,
  getPaths,
  type JunctionPaths,
  loadConfigState,
  type Repositories,
} from "@junction/core"

// ---------------------------------------------------------------------------
// Memoized DB connection. CRITICAL: this server is long-running, unlike the
// one-shot CLI. getDatabase() opens a NEW better-sqlite3 connection AND re-runs
// the migrator on every call — so calling it per request (as the CLI does, then
// exits) would leak a connection + re-check migrations on every page navigation.
// Open once, reuse; on failure, clear the memo so the next request can retry.
// ---------------------------------------------------------------------------

// Keyed by home path: prod has one fixed JUNCTION_HOME → one cached connection
// reused for the server's lifetime; keying (rather than a single global) also keeps
// per-home test isolation correct and reconnects if the home ever changes.
const dbCache = new Map<string, Promise<Db | null>>()

function getDb(): Promise<Db | null> {
  const { home } = getPaths()
  const existing = dbCache.get(home)
  if (existing) return existing
  // async IIFE → a real Promise<Db|null> (neverthrow's ResultAsync.then is PromiseLike<unknown>;
  // await the ResultAsync to a Result instead).
  const created = (async (): Promise<Db | null> => {
    const r = await getDatabase(getPaths())
    if (r.isErr()) {
      dbCache.delete(home) // allow retry on a later request
      return null
    }
    return r.value
  })()
  dbCache.set(home, created)
  return created
}

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
  const [stateResult, credentialStore, sandbox] = await Promise.all([
    loadConfigState(paths),
    credentialStoreLabel(paths),
    sandboxLabel(),
  ])
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

  return { home: paths.home, initialized, credentialStore, sandbox, counts }
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export type PlatformMeta = {
  id: string
  kind: string
  displayName: string
  baseUrl?: string
}

export async function readPlatforms(): Promise<PlatformMeta[]> {
  return withRepos([], async (repos) => {
    const result = await repos.platforms.list()
    if (result.isErr()) return []
    return result.value.map((p) => ({
      id: String(p.id),
      kind: p.kind,
      displayName: p.displayName,
      ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
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
    }))
  })
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
  mcpEndpointPath: string
  sources: SourceMeta[]
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
      mcpEndpointPath: profile.mcpEndpointPath,
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
