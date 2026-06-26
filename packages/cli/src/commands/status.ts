// SPDX-License-Identifier: AGPL-3.0-only
// `junction status` — report home path, config state, credential store backend, and sandbox.

import {
  createCredentialStore,
  createRepositories,
  createSandbox,
  getDatabase,
  getPaths,
  type JunctionPaths,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import {
  formatStatusHuman,
  formatStatusJson,
  loadConfigStateOrFail,
  type StatusCounts,
} from "../format.js"

/**
 * Resolve the credential-store backend label (exported for TUI data loader — DRY).
 * Only surfaces .kind, never .cause which may carry paths/secrets.
 */
export async function resolveCredentialBackend(paths: JunctionPaths): Promise<string> {
  const result = await createCredentialStore(paths)
  if (result.isErr()) return `unavailable (${result.error.kind})`
  return result.value.backend === "keyring" ? "keyring" : "encrypted-file (auto-generated key)"
}

/**
 * Resolve the sandbox backend label (exported for TUI data loader — DRY).
 */
export async function resolveSandboxBackend(): Promise<string> {
  const result = await createSandbox()
  if (result.isErr()) return `unavailable (${result.error.kind})`
  const caps = result.value.capabilities()
  return `commands=${caps.command} · scripts=${caps.script}`
}

/** Load entity counts from the DB (best-effort — returns null if DB unavailable). */
async function loadCounts(paths: JunctionPaths): Promise<StatusCounts | undefined> {
  const dbResult = await getDatabase(paths)
  if (dbResult.isErr()) return undefined
  const repos = createRepositories(dbResult.value)
  const [platformsResult, credentialsResult, profilesResult] = await Promise.all([
    repos.platforms.list(),
    repos.credentials.list(),
    repos.profiles.list(),
  ])
  return {
    platforms: platformsResult.isOk() ? platformsResult.value.length : 0,
    credentials: credentialsResult.isOk() ? credentialsResult.value.length : 0,
    profiles: profilesResult.isOk() ? profilesResult.value.length : 0,
  }
}

/**
 * Run the status report headlessly (used by both the citty handler and the bare-no-TTY
 * fallback path in index.ts). This avoids duplicating the status assembly.
 */
export async function runStatus(json: boolean): Promise<void> {
  const paths = getPaths()

  const [state, credentialStore, sandbox] = await Promise.all([
    loadConfigStateOrFail(paths, json),
    resolveCredentialBackend(paths),
    resolveSandboxBackend(),
  ])
  if (state === null) return

  if (!state.initialized) {
    const data = {
      home: paths.home,
      configFile: paths.configFile,
      cacheDir: paths.cacheDir,
      initialized: false as const,
      config: null,
      credentialStore,
      sandbox,
    }
    if (json) {
      process.stdout.write(`${formatStatusJson(data)}\n`)
    } else {
      consola.info("Junction is not initialized. Run `junction init` to get started.")
      process.stdout.write(`${formatStatusHuman(data)}\n`)
    }
    return
  }

  const counts = await loadCounts(paths)

  const data = {
    home: paths.home,
    configFile: paths.configFile,
    cacheDir: paths.cacheDir,
    initialized: true as const,
    config: state.config,
    credentialStore,
    sandbox,
    counts,
  }

  if (json) {
    process.stdout.write(`${formatStatusJson(data)}\n`)
  } else {
    consola.success("Junction is initialized.")
    process.stdout.write(`${formatStatusHuman(data)}\n`)
  }
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show junction home path, config state, and credential store backend.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
      default: false,
    },
  },
  async run({ args }) {
    await runStatus(args.json ?? false)
  },
})
