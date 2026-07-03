// SPDX-License-Identifier: AGPL-3.0-only
// Single-flight OAuth refresh — a module-level singleton keyed by credentialId
// (increment 29, slice A2, feasibility-review correction F2 — mandatory, not
// optional).
//
// WHY A MODULE SINGLETON: the multi-account wedge allows MANY SourceRefs to
// share ONE credentialId, and `listTools` fans out concurrently across all a
// profile's enabled sources. A profile with two sources sharing one OAuth
// credential therefore fires TWO concurrent resolves on the same
// credentialId — without coordination, that's two concurrent provider
// refresh calls racing to rotate the same refresh token (the exact atomic-
// rotation hazard refreshIfExpired otherwise protects against in isolation).
//
// junction is a single-process, single-user, localhost tool — an in-memory
// `Map<credentialId, Promise>` is a CORRECT single-flight here, not a
// shortcut. There is no multi-process/distributed deployment to coordinate
// across (see docs/futures/revisit-when.md if that ever changes).

import type { RefreshError, Result } from "@junction/core"
import { err, ResultAsync } from "@junction/core"

type RefreshOutcome = Result<{ accessToken: string | null }, RefreshError>

// Module-scope singleton: shared by every resolve path in this process
// (mcp serve stdio, HTTP serve, cli debug) so ALL of them coordinate through
// the same map, regardless of which one happens to trigger a given refresh.
const inflight = new Map<string, Promise<RefreshOutcome>>()

/**
 * Run `run()` for `credentialId`, single-flighted: if a refresh for this
 * credentialId is already in progress, the caller awaits the SAME underlying
 * promise (both callers resolve to the IDENTICAL Result — identical tokens,
 * never a second provider refresh call). The map entry is removed once the
 * refresh settles (ok or err), so the next expiry can refresh again.
 *
 * neverthrow's ResultAsync wraps a plain Promise<Result<T,E>>; we key the
 * dedup on that underlying promise (not a fresh ResultAsync per caller) so
 * concurrent callers truly share one in-flight operation rather than each
 * kicking off their own `run()`.
 */
export function refreshIfExpiredSingleFlight(
  credentialId: string,
  run: () => ResultAsync<{ accessToken: string | null }, RefreshError>,
): ResultAsync<{ accessToken: string | null }, RefreshError> {
  const existing = inflight.get(credentialId)
  if (existing !== undefined) {
    return new ResultAsync(existing)
  }

  // Wrap run() in an async IIFE with a try/catch so the shared promise NEVER
  // rejects — it always settles to a Result. This is load-bearing:
  //  - `new ResultAsync(promise)` below relies on neverthrow's invariant that
  //    the inner promise never rejects; a raw rejection would surface as an
  //    unhandled throw at EVERY de-duped await site, not a typed Err.
  //  - run() is invoked INSIDE the try, so even a SYNCHRONOUS throw from run()
  //    (or a rejected underlying ResultAsync) becomes a refresh-failed Err
  //    rather than escaping before the map is set.
  const promise: Promise<RefreshOutcome> = (async () => {
    try {
      return await run()
    } catch (cause) {
      return err({ kind: "refresh-failed", cause }) as RefreshOutcome
    }
  })()
  inflight.set(credentialId, promise)
  // Remove the entry once settled, regardless of outcome, so a later expiry
  // triggers a fresh refresh rather than being stuck replaying a stale result.
  void promise.finally(() => {
    if (inflight.get(credentialId) === promise) inflight.delete(credentialId)
  })

  return new ResultAsync(promise)
}
