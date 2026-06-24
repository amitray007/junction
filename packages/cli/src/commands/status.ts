// SPDX-License-Identifier: AGPL-3.0-only
// `junction status` — report home path, config state, and contents.

import { getPaths } from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { formatStatusHuman, formatStatusJson, loadConfigStateOrFail } from "../format.js"

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

    const state = await loadConfigStateOrFail(paths, json)
    if (state === null) return

    if (!state.initialized) {
      const data = {
        home: paths.home,
        configFile: paths.configFile,
        cacheDir: paths.cacheDir,
        initialized: false as const,
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

    const data = {
      home: paths.home,
      configFile: paths.configFile,
      cacheDir: paths.cacheDir,
      initialized: true as const,
      config: state.config,
    }

    if (json) {
      process.stdout.write(`${formatStatusJson(data)}\n`)
    } else {
      consola.success("Junction is initialized.")
      process.stdout.write(`${formatStatusHuman(data)}\n`)
    }
  },
})
