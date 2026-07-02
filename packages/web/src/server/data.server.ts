// SPDX-License-Identifier: AGPL-3.0-only
// Server-only data helpers — the ONLY file in @junction/web that imports @junction/core.
// Called exclusively from data.functions.ts createServerFn handlers.
// SECURITY: credentials output is metadata-only — no secret, no secretRef.

import {
  createCredentialStore,
  createRepositories,
  createSandbox,
  getMcpHost,
  getMcpPort,
  getPaths,
  type JunctionPaths,
  loadConfig,
  loadConfigState,
  type Repositories,
} from "@junction/core"
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
