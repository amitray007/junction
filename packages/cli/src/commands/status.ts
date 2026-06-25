// SPDX-License-Identifier: AGPL-3.0-only
// `junction status` — report home path, config state, and credential store backend.

import { createCredentialStore, getPaths } from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { formatStatusHuman, formatStatusJson, loadConfigStateOrFail } from "../format.js"

async function resolveCredentialBackend(): Promise<string> {
  const paths = getPaths()
  const result = await createCredentialStore(paths)
  // FIX 5: only .kind (an enum) is surfaced — never .cause, which may carry paths/secrets.
  if (result.isErr()) return `unavailable (${result.error.kind})`
  return result.value.backend === "keyring" ? "keyring" : "encrypted-file (auto-generated key)"
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
    const json = args.json ?? false

    const paths = getPaths()

    const [state, credentialStore] = await Promise.all([
      loadConfigStateOrFail(paths, json),
      resolveCredentialBackend(),
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
    }

    if (json) {
      process.stdout.write(`${formatStatusJson(data)}\n`)
    } else {
      consola.success("Junction is initialized.")
      process.stdout.write(`${formatStatusHuman(data)}\n`)
    }
  },
})
