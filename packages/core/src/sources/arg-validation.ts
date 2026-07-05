// SPDX-License-Identifier: AGPL-3.0-only
// Shared agent-arg string validation primitive — used by every source provider
// that validates agent-supplied string values against operator-declared params
// (cli's args.ts, http-client's args.ts). Factored per docs/principles/dry.md §3
// (stable, single-meaning primitive — factor on first reuse, don't wait for three).
//
// SOURCE-AGNOSTIC: no provider-specific types; pure string validation.

import type { UpstreamError } from "../errors/index.js"
import { err, ok, type Result } from "../result/index.js"

/**
 * Reject control characters (NUL, LF, CR, and all C0/C1 controls) in an
 * agent-supplied string value. A NUL in particular makes Node's spawn() throw
 * ERR_INVALID_ARG_VALUE synchronously (CLI provider) — which would escape as
 * an uncaught rejection across the proxy boundary; for HTTP it prevents
 * downstream header/URL injection surprises and unexpected fetch failures.
 * Reject here so both providers turn it into a clean `invalid-args` instead.
 *
 * @param label  Human-readable identifier for the value (e.g. `arg "name"` or
 *               `param "name"`) — interpolated into the returned reason.
 */
export function rejectControlCharacters(value: string, label: string): Result<void, UpstreamError> {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      return err({
        kind: "invalid-args",
        reason: `${label}: value contains a control character (code ${c}) which is not allowed`,
      })
    }
  }
  return ok(undefined)
}
