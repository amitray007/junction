// SPDX-License-Identifier: AGPL-3.0-only
// CLI arg-parsing primitives — shared across commands.
// Named module, NOT a grab-bag (docs/principles/modularity.md §3).

/**
 * Standard --json flag definition for citty commands.
 * Re-used across all commands that support machine-readable output.
 */
export const JSON_ARG = {
  type: "boolean" as const,
  description: "Machine-readable JSON output",
  default: false,
}

/**
 * Extract all values for a repeated flag from citty's rawArgs array.
 * e.g. --arg foo --arg bar → ["foo", "bar"]
 *
 * Values that start with "--" are treated as the next flag, not a value.
 * This matches standard CLI conventions (short flags aside).
 */
export function collectRepeatableFlag(rawArgs: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < rawArgs.length - 1; i++) {
    const next = rawArgs[i + 1]
    if (rawArgs[i] === flag && next !== undefined && !next.startsWith("--")) {
      values.push(next)
    }
  }
  return values
}

/**
 * Read a secret/token from stdin (trimmed). The headless/agent way to supply a
 * secret WITHOUT it ever appearing in argv — used by `credential add|rotate`
 * (--token-stdin/--secret-stdin) and `connect|reconnect` (--client-secret-stdin).
 * `resume()` in case stdin was paused.
 */
export function readStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = ""
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve(data.trim())
    }
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk: string) => {
      data += chunk
    })
    process.stdin.on("end", done)
    // A stream error (e.g. EPIPE / a closed pipe) must not crash the process
    // with an unhandled 'error' event — resolve with whatever was read (a
    // partial/empty read then hits the caller's "secret must not be empty"
    // guard, which reports a clean error) rather than throw.
    process.stdin.on("error", done)
    process.stdin.resume()
  })
}
