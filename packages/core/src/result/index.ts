// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Result primitives for junction/core.
 *
 * Re-exports neverthrow helpers so callers import from @junction/core, not
 * neverthrow directly — one swap point if the underlying lib ever changes.
 */

export { err, ok, type Result, ResultAsync } from "neverthrow"
