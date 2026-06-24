// SPDX-License-Identifier: AGPL-3.0-only
// `junction status` — report home path, config state, and contents.

import { getPaths, loadConfig } from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { formatStatusHuman, formatStatusJson } from "../format.js"

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show junction home path and config state.",
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

    // Check whether config.json actually exists (vs loadConfig returning DEFAULT_CONFIG on ENOENT).
    const { stat } = await import("node:fs/promises")
    let initialized = false
    try {
      await stat(paths.configFile)
      initialized = true
    } catch {
      initialized = false
    }

    if (!initialized) {
      const data = {
        home: paths.home,
        configFile: paths.configFile,
        cacheDir: paths.cacheDir,
        initialized: false,
        config: null,
      }
      if (json) {
        process.stdout.write(`${formatStatusJson(data)}\n`)
      } else {
        consola.info("Junction is not initialized. Run `junction init` to get started.")
        process.stdout.write(`${formatStatusHuman(data)}\n`)
      }
      return
    }

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

    const data = {
      home: paths.home,
      configFile: paths.configFile,
      cacheDir: paths.cacheDir,
      initialized: true,
      config: configResult.value,
    }

    if (json) {
      process.stdout.write(`${formatStatusJson(data)}\n`)
    } else {
      consola.success("Junction is initialized.")
      process.stdout.write(`${formatStatusHuman(data)}\n`)
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
