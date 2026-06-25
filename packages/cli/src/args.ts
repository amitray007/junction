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
