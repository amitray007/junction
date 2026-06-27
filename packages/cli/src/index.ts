#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { VERSION } from "@junction/core"
import { defineCommand, runMain } from "citty"
import { credentialCommand } from "./commands/credential.js"
import { debugCommand } from "./commands/debug.js"
import { initCommand } from "./commands/init.js"
import { mcpCommand } from "./commands/mcp.js"
import { platformCommand } from "./commands/platform.js"
import { profileCommand } from "./commands/profile.js"
import { runStatus, statusCommand } from "./commands/status.js"
import { webCommand } from "./commands/web.js"

const main = defineCommand({
  meta: {
    name: "junction",
    version: VERSION,
    description: "Junction — connect your platforms once, reach them anywhere.",
  },
  subCommands: {
    init: initCommand,
    mcp: mcpCommand,
    platform: platformCommand,
    credential: credentialCommand,
    profile: profileCommand,
    status: statusCommand,
    debug: debugCommand,
    web: webCommand,
  },
})

// ---------------------------------------------------------------------------
// Dispatch: subcommand → citty; bare+TTY → TUI; bare+no-TTY → headless status.
//
// The headless contract is load-bearing:
//   - bare + both TTYs + no --json → interactive Ink dashboard
//   - bare + no TTY (piped/CI/agent) → headless status (no hang, no pipe corruption)
//   - any subcommand or meta flag (--help/--version) → citty as-is
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const hasSubcommand = argv.some((a) => !a.startsWith("-"))
const hasMetaFlag =
  argv.includes("--help") ||
  argv.includes("-h") ||
  argv.includes("--version") ||
  argv.includes("-v")
const wantJson = argv.includes("--json")
const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true

/** Shared CLI error handler: emit JSON error line when --json, always set exitCode=1. */
function onCliError(err: unknown): void {
  if (wantJson) {
    const message = err instanceof Error ? err.message : String(err)
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  }
  process.exitCode = 1
}

if (hasSubcommand || hasMetaFlag) {
  // Citty handles subcommands and meta flags normally.
  runMain(main).catch(onCliError)
} else if (isTTY && !wantJson) {
  // Bare invocation in an interactive terminal → TUI dashboard.
  // Dynamically imported so ink + react are NOT loaded when running subcommands
  // (lazy-load perf rule: junction status --json never pays the React load cost).
  ;(async () => {
    try {
      const { launchDashboard } = await import("./tui/index.js")
      await launchDashboard()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`junction: TUI error: ${message}\n`)
      process.exitCode = 1
    }
  })()
} else {
  // Bare invocation with no TTY (piped/CI/agent) or --json → headless status.
  // Falls back cleanly without hanging or corrupting the pipe.
  ;(async () => {
    try {
      await runStatus(wantJson)
    } catch (err: unknown) {
      onCliError(err)
    }
  })()
}
