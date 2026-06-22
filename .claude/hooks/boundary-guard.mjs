#!/usr/bin/env node
// Junction boundary guard — a PreToolUse hook for Edit/Write.
// Blocks (exit 2) edits that violate load-bearing rules from docs/rules/.
// Reads the Claude Code hook payload as JSON on stdin.
// Dependency-free; keep it that way.

import { readFileSync } from "node:fs"

function readStdin() {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function violationsFor(path, content) {
  const out = []
  if (!path?.endsWith(".ts")) return out

  const isCore = /(^|\/)packages\/core\//.test(path)
  const isServer = /(^|\/)packages\/mcp\//.test(path)

  // 1. No reverse dependency into core: core must not import cli/web/mcp.
  if (isCore) {
    const reverse =
      /from\s+["'][^"']*\/(cli|web|mcp)\b/.test(content) ||
      /@junction\/(cli|web|mcp-server|mcp-client)/.test(content)
    if (reverse) {
      out.push(
        "core/ must not import from cli/web/mcp (dependency direction is one-way). See docs/rules/typescript.md.",
      )
    }
    // 2. No HTTP server / daemon in core.
    if (
      /from\s+["'](express|fastify|hono)["']/.test(content) ||
      /node:http['"]\s*\)?\s*[;\n].*createServer/s.test(content)
    ) {
      out.push("core/ must contain no HTTP server/daemon. See docs/rules/typescript.md.")
    }
  }

  // 3. Banned sandbox APIs anywhere.
  if (/from\s+["']vm2["']/.test(content) || /require\(\s*["']vm2["']\s*\)/.test(content)) {
    out.push("vm2 is banned (active RCEs; not a sandbox). See docs/rules/security.md.")
  }
  if (/from\s+["']node:vm["']/.test(content) || /require\(\s*["']vm["']\s*\)/.test(content)) {
    out.push("node:vm is banned as a sandbox. Use Deno + bubblewrap. See docs/rules/security.md.")
  }

  // 4. No sync I/O in core/server paths.
  if (isCore || isServer) {
    if (
      /\bfs\.[a-zA-Z]+Sync\s*\(/.test(content) ||
      /\bexecSync\s*\(/.test(content) ||
      /readFileSync|writeFileSync/.test(content)
    ) {
      out.push(
        "No fs.*Sync / execSync in core or mcp/* paths (blocks the event loop). See docs/rules/performance.md.",
      )
    }
  }

  return out
}

function main() {
  const raw = readStdin()
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    process.exit(0) // can't parse — don't block
  }

  const input = payload.tool_input ?? {}
  const path = input.file_path ?? input.path ?? ""
  // Edit uses new_string; Write uses content. Check whatever is present.
  const content = input.content ?? input.new_string ?? ""
  if (!content) process.exit(0)

  const violations = violationsFor(path, content)
  if (violations.length > 0) {
    const msg = [
      "Junction boundary guard blocked this edit:",
      ...violations.map((v) => `  • ${v}`),
    ].join("\n")
    // exit 2 → Claude Code surfaces stderr to the model as a blocking error.
    process.stderr.write(`${msg}\n`)
    process.exit(2)
  }
  process.exit(0)
}

main()
