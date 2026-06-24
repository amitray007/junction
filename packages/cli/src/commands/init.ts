// SPDX-License-Identifier: AGPL-3.0-only
// `junction init` — ensure home + write default config.

import { DEFAULT_CONFIG, ensureHome, saveConfig } from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import {
  formatConfigError,
  formatInitJson,
  formatPathsError,
  loadConfigStateOrFail,
} from "../format.js"

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize the junction home directory and write the default config.",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Skip interactive confirmation",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output (implies --yes)",
      default: false,
    },
  },
  async run({ args }) {
    const json = args.json ?? false
    const yes = args.yes ?? false

    // Resolve paths first so we can show the home path in the prompt.
    const pathsResult = await ensureHome()
    if (pathsResult.isErr()) {
      const e = pathsResult.error
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: formatPathsError(e) })}\n`)
      } else {
        consola.error(formatPathsError(e))
      }
      process.exitCode = 1
      return
    }

    const paths = pathsResult.value

    // Interactive confirmation unless --yes or --json.
    if (!yes && !json) {
      // Lazy-import @clack/prompts — only needed for interactive path.
      const { confirm, isCancel, intro, outro } = await import("@clack/prompts")
      intro("junction init")
      const confirmed = await confirm({
        message: `Create junction home at ${paths.home}?`,
      })
      if (isCancel(confirmed) || !confirmed) {
        outro("Aborted.")
        process.exit(0)
      }
    }

    // Check if already initialized (config file exists) and validate if so.
    // Fail cleanly on a corrupt config rather than silently overwriting it.
    const state = await loadConfigStateOrFail(paths, json)
    if (state === null) return

    if (state.initialized) {
      if (json) {
        process.stdout.write(`${formatInitJson({ ok: true, home: paths.home, created: false })}\n`)
      } else {
        consola.success(`Already initialized — home: ${paths.home}`)
      }
      return
    }

    // TOCTOU: initialized-check and saveConfig are not atomic. For a single-user
    // broker this is acceptable — saveConfig's home-dir lock + atomic rename
    // prevents file corruption; only the created:true/false flag is racy.
    const saveResult = await saveConfig(paths, DEFAULT_CONFIG)
    if (saveResult.isErr()) {
      const e = saveResult.error
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: formatConfigError(e) })}\n`)
      } else {
        consola.error(`Failed to write config: ${formatConfigError(e)}`)
      }
      process.exitCode = 1
      return
    }

    if (json) {
      process.stdout.write(`${formatInitJson({ ok: true, home: paths.home, created: true })}\n`)
    } else {
      consola.success(`Junction initialized — home: ${paths.home}`)
    }
  },
})
