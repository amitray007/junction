// SPDX-License-Identifier: AGPL-3.0-only
// Arg validation for the http provider. Pure helpers — no fetch, no I/O.
// Validates agent-supplied values against operator-declared HttpParam specs.
// Mirrors core/src/sources/cli/args.ts's validateArgs/validateArgValue shape
// (type/enum/pattern/maxLength/required/unknown-key checks) — HttpParam has
// no "path" type (path-injection is guarded downstream by
// @junction/openapi-client's validatePathValue, reused by buildAndExecuteRequest)
// and carries `in` instead of an argv template segment.
//
// Security contract: every agent-supplied value is validated here before it
// reaches buildAndExecuteRequest. Unknown arg keys are rejected
// (additionalProperties:false, mirroring the tool's inputSchema).

import { type HttpParam, rejectControlCharacters, type UpstreamError } from "@junction/core"
import { err, ok, type Result } from "neverthrow"

// ---------------------------------------------------------------------------
// validateParamValue — validate a single agent value against its HttpParam spec
// ---------------------------------------------------------------------------

export function validateParamValue(
  param: HttpParam,
  rawValue: unknown,
): Result<string | number | boolean, UpstreamError> {
  if (param.type === "boolean") {
    if (typeof rawValue !== "boolean") {
      return err({
        kind: "invalid-args",
        reason: `param "${param.name}": expected boolean, got ${typeof rawValue}`,
      })
    }
    return ok(rawValue)
  }

  if (param.type === "number") {
    if (typeof rawValue !== "number") {
      return err({
        kind: "invalid-args",
        reason: `param "${param.name}": expected number, got ${typeof rawValue}`,
      })
    }
    return ok(rawValue)
  }

  // string | enum — must be a string at this point
  if (typeof rawValue !== "string") {
    return err({
      kind: "invalid-args",
      reason: `param "${param.name}": expected string, got ${typeof rawValue}`,
    })
  }
  const strValue = rawValue

  // Reject control characters (NUL, LF, CR, and all C0/C1 controls) — consistent
  // with the CLI arg-validation precedent (prevents downstream header/URL
  // injection surprises and unexpected fetch failures).
  const controlCharResult = rejectControlCharacters(strValue, `param "${param.name}"`)
  if (controlCharResult.isErr()) return err(controlCharResult.error)

  // maxLength check (character count — consistent with JSON Schema maxLength)
  if (param.maxLength !== undefined && strValue.length > param.maxLength) {
    return err({
      kind: "invalid-args",
      reason: `param "${param.name}": value length ${strValue.length} exceeds maxLength ${param.maxLength}`,
    })
  }

  if (param.type === "enum") {
    if (!param.enum?.includes(strValue)) {
      const allowed = param.enum ? param.enum.join(", ") : "(none defined)"
      return err({
        kind: "invalid-args",
        reason: `param "${param.name}": value must be one of: ${allowed}`,
      })
    }
  }

  // Anchored pattern check — applies to string and enum types
  if (param.pattern !== undefined) {
    let re: RegExp
    try {
      re = new RegExp(`^(?:${param.pattern})$`)
    } catch {
      return err({
        kind: "invalid-args",
        reason: `param "${param.name}": pattern is not a valid regex`,
      })
    }
    if (!re.test(strValue)) {
      return err({
        kind: "invalid-args",
        reason: `param "${param.name}": value does not match the required pattern`,
      })
    }
  }

  return ok(strValue)
}

// ---------------------------------------------------------------------------
// validateHttpArgs — validate all agent args against the tool's declared params
// ---------------------------------------------------------------------------

/**
 * Validate ALL agent-supplied args against the tool's declared HttpParam specs.
 *
 * Enforces:
 *   - No unknown keys (additionalProperties: false)
 *   - Required params are present
 *   - Each present value matches its HttpParam declaration (type/enum/pattern/maxLength)
 *
 * Returns a Record from param name → validated value. Absent optional params
 * are NOT in the result — the request builder omits their binding.
 */
export function validateHttpArgs(
  declaredParams: readonly HttpParam[],
  rawArgs: Record<string, unknown>,
): Result<Record<string, string | number | boolean>, UpstreamError> {
  // additionalProperties: false — reject any key not in the declared set
  const declaredNames = new Set(declaredParams.map((p) => p.name))
  for (const key of Object.keys(rawArgs)) {
    if (!declaredNames.has(key)) {
      return err({ kind: "invalid-args", reason: `unknown arg "${key}"` })
    }
  }

  const validated: Record<string, string | number | boolean> = {}

  for (const param of declaredParams) {
    const rawValue = rawArgs[param.name]

    if (rawValue === undefined || rawValue === null) {
      if (param.required) {
        return err({ kind: "invalid-args", reason: `missing required arg "${param.name}"` })
      }
      continue
    }

    const result = validateParamValue(param, rawValue)
    if (result.isErr()) return err(result.error)
    validated[param.name] = result.value
  }

  return ok(validated)
}
