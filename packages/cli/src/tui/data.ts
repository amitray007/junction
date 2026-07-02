// SPDX-License-Identifier: AGPL-3.0-only
// TUI data loader — thin adapter: calls core, returns a plain DashboardSnapshot.
// NO business logic here. Components receive this snapshot; core owns the data.

import {
  createRepositories,
  getDatabase,
  type JunctionPaths,
  loadConfigState,
  type Platform,
  type Profile,
  ResultAsync,
  type SourceRef,
} from "@junction/core"
import { resolveCredentialBackend, resolveSandboxBackend } from "../commands/status.js"

// ---------------------------------------------------------------------------
// DashboardSnapshot — the plain data shape the TUI components receive
// ---------------------------------------------------------------------------

export type DashboardStatus = {
  home: string
  configFile: string
  initialized: boolean
  credentialStore: string
  sandbox: string
}

export type DashboardSource = {
  namespace: string
  platformId: string
  enabled: boolean
}

export type DashboardProfile = {
  id: string
  name: string
  /** Wired sources — NO secret or secretRef; only routing metadata. */
  sources: DashboardSource[]
}

export type DashboardPlatform = {
  id: string
  displayName: string
  kind: string
  credentialCount: number
}

export type DashboardSnapshot = {
  status: DashboardStatus
  profiles: DashboardProfile[]
  platforms: DashboardPlatform[]
}

export type SnapshotError = {
  kind: "load-failed"
  message: string
}

// ---------------------------------------------------------------------------
// loadDashboardSnapshot — the sole entry point for TUI data
// ---------------------------------------------------------------------------

/**
 * Load a complete DashboardSnapshot from core.
 *
 * Reuses resolveCredentialBackend + resolveSandboxBackend from the status
 * command (DRY — no duplication of the status assembly).
 *
 * NEVER includes secret values — credentials contribute only a count per
 * platform. The secretRef field is intentionally excluded from all snapshot
 * types.
 */
export function loadDashboardSnapshot(
  paths: JunctionPaths,
): ResultAsync<DashboardSnapshot, SnapshotError> {
  return ResultAsync.fromPromise(
    buildSnapshot(paths),
    (e: unknown): SnapshotError => ({
      kind: "load-failed",
      message: e instanceof Error ? e.message : String(e),
    }),
  )
}

async function buildSnapshot(paths: JunctionPaths): Promise<DashboardSnapshot> {
  // --- Status panel data (reuse exported helpers from status command) ---
  const configStateResult = await loadConfigState(paths)
  const initialized = configStateResult.isOk() && configStateResult.value.initialized

  const [credentialStore, sandbox] = await Promise.all([
    resolveCredentialBackend(paths),
    resolveSandboxBackend(),
  ])

  const status: DashboardStatus = {
    home: paths.home,
    configFile: paths.configFile,
    initialized,
    credentialStore,
    sandbox,
  }

  // --- DB-backed panels (profiles + platforms) ---
  const dbResult = await getDatabase(paths)
  if (dbResult.isErr()) {
    // DB unavailable (e.g. not yet initialised): return status-only snapshot
    return { status, profiles: [], platforms: [] }
  }

  const repos = createRepositories(dbResult.value)
  const [profilesResult, platformsResult, credentialsResult] = await Promise.all([
    repos.profiles.list(),
    repos.platforms.list(),
    repos.credentials.list(),
  ])

  const profiles: DashboardProfile[] = profilesResult.isOk()
    ? profilesResult.value.map((p: Profile) => ({
        id: p.id,
        name: p.name,
        // Only routing metadata — NEVER secret or secretRef
        sources: p.sources.map((sr: SourceRef) => ({
          namespace: sr.toolNamespace,
          platformId: String(sr.platformId),
          enabled: sr.enabled,
        })),
      }))
    : []

  // Count credentials per platform (NEVER include secretRef — counts only)
  const credCountByPlatform = new Map<string, number>()
  if (credentialsResult.isOk()) {
    for (const cred of credentialsResult.value) {
      credCountByPlatform.set(cred.platformId, (credCountByPlatform.get(cred.platformId) ?? 0) + 1)
    }
  }

  const platforms: DashboardPlatform[] = platformsResult.isOk()
    ? platformsResult.value.map((p: Platform) => ({
        id: p.id,
        displayName: p.displayName,
        kind: p.kind,
        credentialCount: credCountByPlatform.get(p.id) ?? 0,
      }))
    : []

  return { status, profiles, platforms }
}
