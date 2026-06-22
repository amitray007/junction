#!/usr/bin/env node

// Junction format-on-edit — a PostToolUse hook for Edit/Write.
// Runs `biome check --write` on the single edited file. Fast, best-effort.
// Reads the Claude Code hook payload as JSON on stdin. Never blocks (always exit 0).

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

function readStdin() {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

try {
  const payload = JSON.parse(readStdin())
  const input = payload.tool_input ?? {}
  const path = input.file_path ?? input.path ?? ""
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

  if (/\.(ts|tsx|js|jsx|json)$/.test(path)) {
    execFileSync("pnpm", ["--dir", projectDir, "exec", "biome", "check", "--write", path], {
      stdio: "ignore",
    })
  }
} catch {
  // best-effort: never block an edit on formatting
}
process.exit(0)
