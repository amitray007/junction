// SPDX-License-Identifier: AGPL-3.0-only
// `junction status` — report home path, config state, credential store backend, and sandbox.

import { createCredentialStore, createSandbox, getPaths, type JunctionPaths } from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { formatStatusHuman, formatStatusJson, loadConfigStateOrFail } from "../format.js"

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

  const data = {
    home: paths.home,
    configFile: paths.configFile,
    cacheDir: paths.cacheDir,
    initialized: true as const,
    config: state.config,
    credentialStore,
    sandbox,
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
