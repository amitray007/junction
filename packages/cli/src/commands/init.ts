// SPDX-License-Identifier: AGPL-3.0-only
// `junction init` — ensure home + write default config.

import { DEFAULT_CONFIG, ensureHome, loadConfig, saveConfig } from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { formatInitJson } from "../format.js"

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
        process.stdout.write(`${JSON.stringify({ ok: false, error: String(e.cause) })}\n`)
      } else {
        consola.error(`Failed to resolve home: ${String(e.cause)}`)
      }
      process.exit(1)
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

    // Check if already initialized (config file exists).
    const configResult = await loadConfig(paths)
    if (configResult.isErr()) {
      const e = configResult.error
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: formatConfigError(e) })}\n`)
      } else {
        consola.error(`Failed to read config: ${formatConfigError(e)}`)
      }
      process.exit(1)
    }

    // Distinguish "file exists and was loaded" vs "file absent, got DEFAULT_CONFIG".
    // loadConfig returns ok(DEFAULT_CONFIG) when ENOENT — we check if config.json exists
    // by trying to save only if needed. Use a stat to avoid a second round-trip.
    const { stat } = await import("node:fs/promises")
    let initialized = false
    try {
      await stat(paths.configFile)
      initialized = true
    } catch {
      initialized = false
    }

    if (initialized) {
      if (json) {
        process.stdout.write(`${formatInitJson({ ok: true, home: paths.home, created: false })}\n`)
      } else {
        consola.success(`Already initialized — home: ${paths.home}`)
      }
      return
    }

    // Write default config.
    const saveResult = await saveConfig(paths, DEFAULT_CONFIG)
    if (saveResult.isErr()) {
      const e = saveResult.error
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: formatConfigError(e) })}\n`)
      } else {
        consola.error(`Failed to write config: ${formatConfigError(e)}`)
      }
      process.exit(1)
    }

    if (json) {
      process.stdout.write(`${formatInitJson({ ok: true, home: paths.home, created: true })}\n`)
    } else {
      consola.success(`Junction initialized — home: ${paths.home}`)
    }
  },
})

function formatConfigError(
  e:
    | { kind: "read-failed"; cause: unknown }
    | { kind: "invalid"; issues: string[] }
    | { kind: "write-failed"; cause: unknown }
    | { kind: "lock-failed"; cause: unknown },
): string {
  if (e.kind === "invalid") return `invalid config: ${e.issues.join(", ")}`
  if (e.kind === "lock-failed") return `config lock failed: ${String(e.cause)}`
  if (e.kind === "read-failed") return `config read failed: ${String(e.cause)}`
  return `config write failed: ${String(e.cause)}`
}
