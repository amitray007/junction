// SPDX-License-Identifier: AGPL-3.0-only
// refreshIfExpiredSingleFlight tests — reproduces the REAL concurrency source
// (F2): a `listTools` fan-out where two SourceRefs share one credentialId
// fires exactly ONE provider refresh, and both callers observe identical
// tokens. Also proves different credentialIds don't false-share, and that the
// map is cleaned up after settle so a later refresh isn't stuck replaying a
// stale result.

import type { RefreshError } from "@junction/core"
import { err, ok, ResultAsync } from "@junction/core"
import { describe, expect, it } from "vitest"
import { refreshIfExpiredSingleFlight } from "./refresh-singleflight.js"

/** A deferred promise, so the test controls exactly when `run` resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * Build a slow, awaitable `run()` that only settles once `gate` resolves, and
 * counts its own invocations — the shape `refreshIfExpiredSingleFlight`
 * expects (a thunk returning ResultAsync<{accessToken}, RefreshError>).
 */
function makeSlowRun(
  gate: Promise<void>,
  token: string,
  counter: { calls: number },
): () => ResultAsync<{ accessToken: string }, RefreshError> {
  return () => {
    counter.calls++
    return ResultAsync.fromSafePromise(gate.then(() => ({ accessToken: token })))
  }
}

describe("refreshIfExpiredSingleFlight", () => {
  it("two concurrent calls for the SAME credentialId → run() called EXACTLY ONCE, both callers get identical tokens (the real listTools fan-out race)", async () => {
    const gate = deferred<void>()
    const counter = { calls: 0 }
    const run = makeSlowRun(gate.promise, "shared-fresh-token", counter)

    const credentialId = "cred_shared"
    // Fire "simultaneously" — mirrors listTools's Promise.all fan-out where
    // two enabled sources reference the same OAuth credential.
    const p1 = refreshIfExpiredSingleFlight(credentialId, run)
    const p2 = refreshIfExpiredSingleFlight(credentialId, run)

    // Let the refresh complete.
    gate.resolve(undefined)
    const [r1, r2] = await Promise.all([p1, p2])

    expect(counter.calls).toBe(1) // run() invoked EXACTLY ONCE
    expect(r1.isOk()).toBe(true)
    expect(r2.isOk()).toBe(true)
    if (r1.isOk() && r2.isOk()) {
      expect(r1.value.accessToken).toBe("shared-fresh-token")
      expect(r2.value.accessToken).toBe("shared-fresh-token")
      expect(r1.value).toEqual(r2.value) // identical tokens
    }
  })

  it("two DIFFERENT credentialIds → run() called TWICE (no false sharing)", async () => {
    const gateA = deferred<void>()
    const gateB = deferred<void>()
    const counterA = { calls: 0 }
    const counterB = { calls: 0 }
    const runA = makeSlowRun(gateA.promise, "token-a", counterA)
    const runB = makeSlowRun(gateB.promise, "token-b", counterB)

    const pA = refreshIfExpiredSingleFlight("cred_a", runA)
    const pB = refreshIfExpiredSingleFlight("cred_b", runB)

    gateA.resolve(undefined)
    gateB.resolve(undefined)
    const [rA, rB] = await Promise.all([pA, pB])

    expect(counterA.calls).toBe(1)
    expect(counterB.calls).toBe(1)
    expect(rA.isOk() && rA.value.accessToken).toBe("token-a")
    expect(rB.isOk() && rB.value.accessToken).toBe("token-b")
  })

  it("after settle, a fresh call re-runs (map cleaned up) — both success and error paths clear the entry", async () => {
    const credentialId = "cred_reuse"

    // First refresh succeeds and settles.
    const counter1 = { calls: 0 }
    const gate1 = deferred<void>()
    const result1 = await (() => {
      const p = refreshIfExpiredSingleFlight(
        credentialId,
        makeSlowRun(gate1.promise, "first-token", counter1),
      )
      gate1.resolve(undefined)
      return p
    })()
    expect(counter1.calls).toBe(1)
    expect(result1.isOk() && result1.value.accessToken).toBe("first-token")

    // A second call for the SAME credentialId after the first settled must
    // trigger a NEW run — proving the map entry was removed, not stuck
    // replaying the first (stale) result.
    const counter2 = { calls: 0 }
    const gate2 = deferred<void>()
    const result2 = await (() => {
      const p = refreshIfExpiredSingleFlight(
        credentialId,
        makeSlowRun(gate2.promise, "second-token", counter2),
      )
      gate2.resolve(undefined)
      return p
    })()
    expect(counter2.calls).toBe(1)
    expect(result2.isOk() && result2.value.accessToken).toBe("second-token")

    // Error path also clears the entry.
    const errRun = (): ResultAsync<{ accessToken: string }, RefreshError> =>
      new ResultAsync(Promise.resolve(err({ kind: "refresh-failed", cause: "boom" })))
    const errResult = await refreshIfExpiredSingleFlight(credentialId, errRun)
    expect(errResult.isErr()).toBe(true)

    const counter3 = { calls: 0 }
    const gate3 = deferred<void>()
    const result3 = await (() => {
      const p = refreshIfExpiredSingleFlight(
        credentialId,
        makeSlowRun(gate3.promise, "third-token", counter3),
      )
      gate3.resolve(undefined)
      return p
    })()
    expect(counter3.calls).toBe(1)
    expect(result3.isOk() && result3.value.accessToken).toBe("third-token")
  })

  it("a REJECTING underlying promise settles to a refresh-failed Err, never throws (Result contract preserved)", async () => {
    // If run()'s ResultAsync wraps a promise that REJECTS (a thrown error, not
    // an Err Result), the single-flight must catch it into an Err — otherwise
    // `new ResultAsync(rejectingPromise)` breaks neverthrow's no-reject
    // invariant and throws at every de-duped await site.
    const rejectingRun = (): ResultAsync<{ accessToken: string | null }, RefreshError> =>
      new ResultAsync(Promise.reject(new Error("inner boom")))
    const result = await refreshIfExpiredSingleFlight("reject-id", rejectingRun)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("refresh-failed")

    // The map entry is cleaned up → a fresh call re-runs and can succeed.
    const okResult = await refreshIfExpiredSingleFlight(
      "reject-id",
      (): ResultAsync<{ accessToken: string | null }, RefreshError> =>
        new ResultAsync(Promise.resolve(ok({ accessToken: "recovered" }))),
    )
    expect(okResult.isOk() && okResult.value.accessToken).toBe("recovered")
  })

  it("a SYNCHRONOUS throw from run() becomes a refresh-failed Err, never escapes", async () => {
    const throwingRun = (): ResultAsync<{ accessToken: string | null }, RefreshError> => {
      throw new Error("sync boom")
    }
    // Must not throw synchronously out of refreshIfExpiredSingleFlight.
    const result = await refreshIfExpiredSingleFlight("sync-throw-id", throwingRun)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("refresh-failed")
  })
})
