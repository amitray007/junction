#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { VERSION } from "@junction/core"
import { defineCommand, runMain } from "citty"
import { initCommand } from "./commands/init.js"
import { mcpCommand } from "./commands/mcp.js"
import { profileCommand } from "./commands/profile.js"
import { statusCommand } from "./commands/status.js"

const main = defineCommand({
  meta: {
    name: "junction",
    version: VERSION,
    description: "Junction — connect your platforms once, reach them anywhere.",
  },
  subCommands: {
    init: initCommand,
    mcp: mcpCommand,
    profile: profileCommand,
    status: statusCommand,
  },
})

runMain(main).catch((err: unknown) => {
  const wantJson = process.argv.includes("--json")
  if (wantJson) {
    const message = err instanceof Error ? err.message : String(err)
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  }
  process.exitCode = 1
})
