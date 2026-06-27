// SPDX-License-Identifier: AGPL-3.0-only
// Argv building for the CLI provider. Pure helper — no I/O, no sandbox.
//
// Security contract:
//   - Each segment yields ≤1 argv element — the agent CANNOT widen argv.
//   - literal segment → its exact value (operator-fixed; agent cannot alter it).
//   - arg segment, value present → exactly ONE element: (prefix ?? "") + String(value).
//   - arg segment, value absent (optional not supplied) → ZERO elements (omit).
//   - No string interpolation, no shell expansion — the array goes to spawn() shell:false.

import type { CliArgvSegment } from "../../schema/cli-connection.js"

/**
 * Build the final argv array from a segment template and pre-validated arg values.
 *
 * Pre-condition: validatedArgs contains only values that passed validateArgs().
 * The invariant that each segment yields ≤1 element is enforced by construction —
 * there is no code path that can emit more than one string per loop iteration.
 *
 * @param segments      The argv template from the CliToolSchema (operator-declared).
 * @param validatedArgs Map of arg name → validated value. Absent key = optional not supplied.
 */
export function buildArgv(
  segments: readonly CliArgvSegment[],
  validatedArgs: ReadonlyMap<string, string | number | boolean>,
): string[] {
  const argv: string[] = []

  for (const seg of segments) {
    if (seg.kind === "literal") {
      // Operator-fixed literal — always emitted as-is; agent has no input here.
      argv.push(seg.value)
    } else {
      // seg.kind === "arg"
      const value = validatedArgs.get(seg.name)
      if (value === undefined) {
        // Optional arg not supplied — omit this slot entirely (zero elements).
        continue
      }
      // Exactly one element: optional static prefix + string representation of value.
      // String(value) is safe for boolean/number and is already a string for string/path/enum.
      argv.push((seg.prefix ?? "") + String(value))
    }
  }

  return argv
}
