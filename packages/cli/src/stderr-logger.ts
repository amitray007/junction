// SPDX-License-Identifier: AGPL-3.0-only
// CLI Logger implementation — writes one JSON line per call to stderr, NEVER
// stdout. `junction mcp serve` carries the MCP protocol on stdout, so any
// logging that lands there would corrupt the stream. Dependency-free and
// synchronous by design (no pino here — the audit sink stays separate; see
// packages/core/src/logging/index.ts for the Logger seam this implements).

import type { Logger } from "@junction/core"

function writeLine(level: string, msg: string, meta?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ level, msg, ...meta })}\n`)
}

export const stderrLogger: Logger = {
  debug: (msg, meta) => writeLine("debug", msg, meta),
  info: (msg, meta) => writeLine("info", msg, meta),
  warn: (msg, meta) => writeLine("warn", msg, meta),
  error: (msg, meta) => writeLine("error", msg, meta),
}
