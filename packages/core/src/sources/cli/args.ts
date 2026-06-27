// SPDX-License-Identifier: AGPL-3.0-only
// Arg validation for the CLI provider. Pure helpers — no sandbox, no I/O.
// Validates agent-supplied values against operator-declared CliArg specs.
//
// Security contract: every agent-supplied value is validated here before it
// reaches buildArgv. Unknown arg keys are rejected (additionalProperties:false).
// type:"path" values are verified to be relative, contain no ".." components,
// and stay within the tool's cwd when joined.

import path from "node:path"
import type { UpstreamError } from "../../errors/index.js"
import { err, ok, type Result } from "../../result/index.js"
import type { CliArg } from "../../schema/cli-connection.js"

// ---------------------------------------------------------------------------
// validateArgValue — validate a single agent value against its CliArg spec
// ---------------------------------------------------------------------------

/**
 * Validate one agent-supplied value against its CliArg declaration.
 * Returns the validated value (typed as string|number|boolean) on success.
 *
 * The cwd parameter is needed for type:"path" — the joined path must stay within it.
 */
export function validateArgValue(
  arg: CliArg,
  rawValue: unknown,
  cwd: string,
): Result<string | number | boolean, UpstreamError> {
  if (arg.type === "boolean") {
    if (typeof rawValue !== "boolean") {
      return err({
        kind: "invalid-args",
        reason: `arg "${arg.name}": expected boolean, got ${typeof rawValue}`,
      })
    }
    return ok(rawValue)
  }

  if (arg.type === "number") {
    if (typeof rawValue !== "number") {
      return err({
        kind: "invalid-args",
        reason: `arg "${arg.name}": expected number, got ${typeof rawValue}`,
      })
    }
    return ok(rawValue)
  }

  // string | enum | path — must be a string at this point
  if (typeof rawValue !== "string") {
    return err({
      kind: "invalid-args",
      reason: `arg "${arg.name}": expected string, got ${typeof rawValue}`,
    })
  }
  const strValue = rawValue

  // Reject control characters (NUL, LF, CR, and all C0/C1 controls). A NUL in
  // particular makes Node's spawn() throw ERR_INVALID_ARG_VALUE synchronously —
  // which would escape as an uncaught rejection across the proxy boundary. Reject
  // here so it becomes a clean invalid-args instead. (Applies to string/enum/path.)
  for (let i = 0; i < strValue.length; i++) {
    const c = strValue.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      return err({
        kind: "invalid-args",
        reason: `arg "${arg.name}": value contains a control character (code ${c}) which is not allowed`,
      })
    }
  }

  // maxLength check (character count — consistent with JSON Schema maxLength)
  if (arg.maxLength !== undefined && strValue.length > arg.maxLength) {
    return err({
      kind: "invalid-args",
      reason: `arg "${arg.name}": value length ${strValue.length} exceeds maxLength ${arg.maxLength}`,
    })
  }

  if (arg.type === "enum") {
    if (!arg.enum || !arg.enum.includes(strValue)) {
      const allowed = arg.enum ? arg.enum.join(", ") : "(none defined)"
      return err({
        kind: "invalid-args",
        reason: `arg "${arg.name}": value must be one of: ${allowed}`,
      })
    }
  }

  // Anchored pattern check — applies to string, enum, and path types
  if (arg.pattern !== undefined) {
    let re: RegExp
    try {
      re = new RegExp(`^(?:${arg.pattern})$`)
    } catch {
      return err({
        kind: "invalid-args",
        reason: `arg "${arg.name}": pattern is not a valid regex`,
      })
    }
    if (!re.test(strValue)) {
      return err({
        kind: "invalid-args",
        reason: `arg "${arg.name}": value does not match the required pattern`,
      })
    }
  }

  if (arg.type === "path") {
    // Must be relative — agent cannot supply an absolute path
    if (path.isAbsolute(strValue)) {
      return err({
        kind: "invalid-args",
        reason: `arg "${arg.name}": path must be relative (absolute paths not allowed)`,
      })
    }
    // No ".." components — split on path separators and check each segment
    const parts = strValue.split(/[/\\]/)
    for (const part of parts) {
      if (part === "..") {
        return err({
          kind: "invalid-args",
          reason: `arg "${arg.name}": path must not contain ".." components`,
        })
      }
    }
    // Must stay within cwd when joined — path.join normalises redundant slashes/dots
    const joined = path.join(cwd, strValue)
    const rel = path.relative(cwd, joined)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return err({
        kind: "invalid-args",
        reason: `arg "${arg.name}": path escapes the working directory`,
      })
    }
  }

  return ok(strValue)
}

// ---------------------------------------------------------------------------
// validateArgs — validate all agent args against the tool's declared specs
// ---------------------------------------------------------------------------

/**
 * Validate ALL agent-supplied args against the tool's declared CliArg specs.
 *
 * Enforces:
 *   - No unknown keys (additionalProperties: false)
 *   - Required args are present
 *   - Each present value matches its CliArg declaration (type/enum/pattern/maxLength/path)
 *
 * Returns a Map from arg name → validated value.
 * Absent optional args are NOT in the map — callers omit those argv segments.
 */
export function validateArgs(
  declaredArgs: readonly CliArg[],
  rawArgs: Record<string, unknown>,
  cwd: string,
): Result<Map<string, string | number | boolean>, UpstreamError> {
  // additionalProperties: false — reject any key not in the declared set
  const declaredNames = new Set(declaredArgs.map((a) => a.name))
  for (const key of Object.keys(rawArgs)) {
    if (!declaredNames.has(key)) {
      return err({ kind: "invalid-args", reason: `unknown arg "${key}"` })
    }
  }

  const validated = new Map<string, string | number | boolean>()

  for (const arg of declaredArgs) {
    const rawValue = rawArgs[arg.name]

    if (rawValue === undefined || rawValue === null) {
      if (arg.required) {
        return err({ kind: "invalid-args", reason: `missing required arg "${arg.name}"` })
      }
      // Optional and absent — leave out of map (argv segment will be omitted)
      continue
    }

    const result = validateArgValue(arg, rawValue, cwd)
    if (result.isErr()) return err(result.error)
    validated.set(arg.name, result.value)
  }

  return ok(validated)
}
