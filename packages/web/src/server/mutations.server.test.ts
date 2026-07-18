// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for mutations.server.ts's mutateAddCredential platform-lookup error
// mapping (correctness-review fix: a non-not-found platforms.get error kind must
// not collapse to the same "Platform not found" message as an actual missing row).
//
// createRepositories/createCredentialStore/getDb are mocked so this test can force
// a deterministic non-not-found DbError from platforms.get without needing to
// engineer a real sqlite-level failure — mutateAddCredential returns before ever
// touching addCredential/the store on this path, so the mock only needs to cover
// the platform lookup.

import { errAsync, okAsync } from "neverthrow"
import { afterEach, describe, expect, it, vi } from "vitest"

const getMock = vi.fn()
const credentialsGetMock = vi.fn()
const forPlatformMock = vi.fn()
// Increment 42 — addCredential now reads list() (not just forPlatform) to
// derive a name when the caller doesn't supply one; every mutateAddCredential
// mock scenario needs this stubbed alongside forPlatform.
const credentialsListMock = vi.fn()
const setVerifyStateMock = vi.fn()
const storeGetMock = vi.fn()
const storeSetMock = vi.fn()
const credentialsCreateMock = vi.fn()
const verifyCredentialMock = vi.fn()
// refreshIfExpired (core) and oauthRefreshFn (source-runtime) are mocked at
// the module boundary rather than driven for real: testCredential's oauth2
// branch only needs to prove ITS OWN dispatch on refreshIfExpired's outcome
// (token/needs-reauth/refresh-failed) — refreshIfExpired's own refresh
// mechanics (store reads, rotation, atomic write) already have a dedicated
// suite in packages/core/src/oauth/refresh.test.ts. Driving the real thing
// here would mean re-mocking store.get for 3 different refs + setOAuthTokens
// just to re-prove logic this file isn't responsible for.
const refreshIfExpiredMock = vi.fn()
// refreshIfExpiredSingleFlight is a real pass-through to `run()` here (not a
// vi.fn stub) — it's pure plumbing (keys an in-memory Map by credentialId);
// stubbing it would hide a wiring bug where testCredential forgets to call it.
const refreshIfExpiredSingleFlightMock = vi.fn((_credentialId: string, run: () => unknown) => run())
// Increment 45 (Slice C) — the verify-hint call sites (mutateAddCredential's
// verify=true branch, loadPlatformForCredential, resolveTokenForTest) now go
// through resolveCredentialProviderId, which loads custom designs at the I/O
// edge. Stub it so these unit tests never touch the real filesystem —
// default to "no custom designs" (ok([])), matching every existing fixture
// (none reference a custom:<slug> design).
const loadCustomDesignsMock = vi.fn((_paths?: unknown) => okAsync([]))

vi.mock("@junction/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/core")>()
  return {
    ...actual,
    // Increment 45 (Slice C) — `oauthDesignsFile` must be a real (but
    // nonexistent) path: resolveCredentialProviderId/resolveTokenForTest call
    // core's `loadCustomDesigns` INTERNALLY (a core-to-core import, not
    // through this `@junction/core` mock), so it isn't intercepted by the
    // `loadCustomDesignsMock` stub below — it always runs for real. A path
    // whose directory doesn't exist resolves via ENOENT to a clean `ok([])`,
    // matching the intended "no custom designs" default, instead of a noisy
    // (but still gracefully-degraded) `read-failed` from `readFile(undefined)`.
    getPaths: vi.fn(
      () =>
        ({ home: "/fake", oauthDesignsFile: "/fake/oauth-designs.json" }) as ReturnType<
          typeof actual.getPaths
        >,
    ),
    loadCustomDesigns: (...args: unknown[]) => loadCustomDesignsMock(...args),
    createCredentialStore: vi.fn(
      () =>
        okAsync({ get: storeGetMock, set: storeSetMock }) as unknown as ReturnType<
          typeof actual.createCredentialStore
        >,
    ),
    createRepositories: vi.fn(
      () =>
        ({
          platforms: { get: getMock },
          credentials: {
            get: credentialsGetMock,
            forPlatform: forPlatformMock,
            list: credentialsListMock,
            setVerifyState: setVerifyStateMock,
            create: credentialsCreateMock,
          },
        }) as unknown as ReturnType<typeof actual.createRepositories>,
    ),
    refreshIfExpired: (...args: unknown[]) => refreshIfExpiredMock(...args),
  }
})

vi.mock("@junction/source-runtime", () => ({
  verifyCredential: (...args: unknown[]) => verifyCredentialMock(...args),
  oauthRefreshFn: vi.fn(),
  refreshIfExpiredSingleFlight: (...args: [string, () => unknown]) =>
    refreshIfExpiredSingleFlightMock(...args),
}))

vi.mock("./shared.server.js", () => ({
  getDb: vi.fn(async () => ({})),
}))

const { mutateAddCredential, testCredential } = await import("./mutations.server.js")

afterEach(() => {
  getMock.mockReset()
  credentialsGetMock.mockReset()
  forPlatformMock.mockReset()
  credentialsListMock.mockReset()
  setVerifyStateMock.mockReset()
  storeGetMock.mockReset()
  storeSetMock.mockReset()
  credentialsCreateMock.mockReset()
  verifyCredentialMock.mockReset()
  refreshIfExpiredMock.mockReset()
  refreshIfExpiredSingleFlightMock.mockClear()
  loadCustomDesignsMock.mockReset()
  loadCustomDesignsMock.mockReturnValue(okAsync([]))
})

describe("mutateAddCredential — platform lookup error mapping", () => {
  it('returns "Platform not found" when platforms.get errs with kind "not-found"', async () => {
    getMock.mockReturnValue(errAsync({ kind: "not-found", entity: "platform", id: "missing" }))

    const result = await mutateAddCredential({
      platformId: "missing",
      account: "acct",
      kind: "bearer",
      secret: "sekrit",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("Platform not found")
  })

  it('maps a non-not-found platforms.get error kind (e.g. "query-failed") to "Database error"', async () => {
    getMock.mockReturnValue(errAsync({ kind: "query-failed", cause: new Error("disk I/O error") }))

    const result = await mutateAddCredential({
      platformId: "whatever",
      account: "acct",
      kind: "bearer",
      secret: "sekrit",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("Database error")
  })
})

// ---------------------------------------------------------------------------
// mutateAddCredential — verify-on-add (28.9). A platform whose kind-compat
// matrix accepts "bearer" (mcp stdio: ["env", "bearer"]) so the real
// addCredential/isKindAccepted validation passes without mocking core's
// kind-compat logic. store.set + credentials.create are mocked to let the
// real addCredential flow through to completion, then verifyCredential runs.
// ---------------------------------------------------------------------------

const verifyOnAddPlatform = {
  id: "mcp-plat",
  kind: "mcp",
  displayName: "Test MCP",
  connection: { transport: "stdio", command: "some-cmd" },
}

describe("mutateAddCredential — verify-on-add secret discipline", () => {
  it("never leaks the plaintext secret or secretRef through the verify=true success result (stringify guard)", async () => {
    getMock.mockReturnValue(okAsync(verifyOnAddPlatform))
    forPlatformMock.mockReturnValue(okAsync([]))
    credentialsListMock.mockReturnValue(okAsync([]))
    storeSetMock.mockReturnValue(okAsync(undefined))
    credentialsCreateMock.mockImplementation((c: { id: string }) => okAsync(c))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await mutateAddCredential({
      platformId: "mcp-plat",
      account: "acct",
      kind: "bearer",
      secret: "super-secret-plaintext-value",
      verify: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.verify).toEqual({ status: "ok" })

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("super-secret-plaintext-value")
    expect(serialized).not.toContain("secretRef")
  })
})

// ---------------------------------------------------------------------------
// mutateAddCredential — increment 42: standalone (unlinked) create path.
// No platformId → addStandaloneCredential, never touches platforms.get.
// ---------------------------------------------------------------------------

describe("mutateAddCredential — standalone (unlinked) create (increment 42)", () => {
  it("no platformId + a valid name creates an unlinked credential, never touching platforms.get", async () => {
    credentialsCreateMock.mockImplementation((c: { id: string }) => okAsync(c))
    storeSetMock.mockReturnValue(okAsync(undefined))

    const result = await mutateAddCredential({
      name: "my-vault-secret",
      kind: "bearer",
      secret: "super-secret-plaintext-value",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.credential.platformId).toBeNull()
    expect(result.credential.name).toBe("my-vault-secret")
    // The platform-lookup path (platforms.get) must never be touched — this
    // is the whole point of "standalone": no platform to look up.
    expect(getMock).not.toHaveBeenCalled()

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("super-secret-plaintext-value")
  })

  it("no platformId and no name → clean error, no store write", async () => {
    const result = await mutateAddCredential({
      kind: "bearer",
      secret: "some-secret",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).toContain("name is required")
    expect(storeSetMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// testCredential — 28.9 Test Connection. Mocks the repo/store/verify layers
// per this file's established pattern (mutateAddCredential's platform-lookup
// suite above) rather than engineering a real sqlite/keyring/network failure.
// ---------------------------------------------------------------------------

// Increment 45, Slice E — `oauthProviderId` set here so the oauth2
// refresh-ahead tests below (which resolve the design via the REAL
// resolveCredentialProviderId → repos.platforms.get, mocked as `getMock`)
// resolve a design instead of degrading to `undefined`. Harmless for the
// other describe blocks in this file — none assert this shape narrower than
// "the same object reference `getMock` was seeded with."
const fakePlatform = {
  id: "plat-1",
  kind: "mcp",
  displayName: "Test",
  oauthProviderId: "google",
} as unknown as Parameters<typeof verifyCredentialMock>[0]
const fakeCredentialRow = { id: "cred-1", platformId: "plat-1", secretRef: "ref-1" }

describe("testCredential", () => {
  it("increment 42: an UNLINKED credential (platformId: null) returns a clean ok:false — nothing to verify", async () => {
    credentialsGetMock.mockReturnValue(
      okAsync({ id: "cred-vault", platformId: null, secretRef: "ref-1" }),
    )

    const result = await testCredential("cred-vault")

    expect(result).toEqual({
      ok: false,
      error: "This credential is not linked to a platform — nothing to verify",
    })
    // Never reaches the platform lookup or the store — the guard is up-front.
    expect(getMock).not.toHaveBeenCalled()
    expect(storeGetMock).not.toHaveBeenCalled()
  })

  it('returns {ok:true, status:"ok"} and persists setVerifyState on a real ok verify', async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("plaintext-secret"))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")

    expect(result).toEqual({ ok: true, status: "ok" })
    expect(setVerifyStateMock).toHaveBeenCalledWith("cred-1", "ok", expect.any(Number))
  })

  it('returns {ok:true, status:"auth-failed"} and persists it', async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("plaintext-secret"))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "auth-failed" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")

    expect(result).toEqual({ ok: true, status: "auth-failed" })
    expect(setVerifyStateMock).toHaveBeenCalledWith("cred-1", "auth-failed", expect.any(Number))
  })

  it('returns {ok:true, status:"unreachable", detail} and persists "unreachable" (no secret/URL in detail)', async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("plaintext-secret"))
    verifyCredentialMock.mockReturnValue(
      okAsync({ status: "unreachable", detail: "connect-failed: TypeError" }),
    )
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")

    expect(result).toEqual({
      ok: true,
      status: "unreachable",
      detail: "connect-failed: TypeError",
    })
    expect(setVerifyStateMock).toHaveBeenCalledWith("cred-1", "unreachable", expect.any(Number))
    // No secret and no URL-shaped substring anywhere in the returned detail.
    expect(result.ok && result.detail).not.toMatch(/plaintext-secret|https?:\/\//)
  })

  it('returns {ok:true, status:"not-verifiable", detail:reason} WITHOUT persisting (not-verifiable is never an event)', async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("plaintext-secret"))
    verifyCredentialMock.mockReturnValue(
      okAsync({ status: "not-verifiable", reason: "running a command has side effects" }),
    )

    const result = await testCredential("cred-1")

    expect(result).toEqual({
      ok: true,
      status: "not-verifiable",
      detail: "running a command has side effects",
    })
    expect(setVerifyStateMock).not.toHaveBeenCalled()
  })

  it("returns a clean {ok:false} when the credential row is not found (no throw)", async () => {
    credentialsGetMock.mockReturnValue(errAsync({ kind: "not-found", entity: "credential" }))

    const result = await testCredential("missing")

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("Credential not found")
    expect(verifyCredentialMock).not.toHaveBeenCalled()
  })

  it("returns a clean {ok:false} when the credential store errors (store failure is NOT null-graceful here — a clean error string)", async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(errAsync({ kind: "keyring-unavailable" }))

    const result = await testCredential("cred-1")

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("Failed to read the stored secret")
    expect(verifyCredentialMock).not.toHaveBeenCalled()
  })

  it("never returns secretRef or the plaintext secret in its result shape (metadata-only guard)", async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("super-secret-value"))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain("super-secret-value")
    expect(serialized).not.toContain("ref-1") // secretRef
    expect(serialized).not.toContain("secretRef")
  })

  // ---------------------------------------------------------------------------
  // Verify-honesty fix: a stored credential (reached via credentialId →
  // secretRef) whose secret resolves to Ok(null) is a LOST secret (cleared
  // keychain entry / deleted key file) — NOT a public/no-auth source. It must
  // never be handed to verifyCredential (which would treat null as "no
  // credential to send" and could verify "ok" anonymously against a lax
  // upstream). It must always come back "unreachable" with a message telling
  // the operator to rotate.
  // ---------------------------------------------------------------------------
  it('store.get resolving Ok(null) → status "unreachable" with a stored-secret-missing detail, verifyCredential NEVER called, persisted as "unreachable" (never "ok")', async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync(null))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")

    expect(result).toEqual({
      ok: true,
      status: "unreachable",
      detail: "stored secret missing — rotate this credential",
    })
    // NO anonymous verify happened.
    expect(verifyCredentialMock).not.toHaveBeenCalled()
    // Persisted as "unreachable", never "ok"/"auth-failed".
    expect(setVerifyStateMock).toHaveBeenCalledWith("cred-1", "unreachable", expect.any(Number))
  })
})

// ---------------------------------------------------------------------------
// testCredential — oauth2 refresh-ahead (increment 30.5, slice 1 bug fix).
//
// The bug: testCredential used to hand verifyCredential the CURRENT
// (possibly-expired) access token straight from `store.get`, so a valid,
// refreshable oauth2 credential reported a false "Auth Failed". The fix
// mirrors source-runtime's resolve-provider.ts refresh-ahead path: for an
// oauth2 credential, refresh via refreshIfExpiredSingleFlight+refreshIfExpired
// BEFORE ever calling verifyCredential.
//
// These tests mock refreshIfExpired directly (not the store reads it makes
// internally) — see the mock-declaration comment above for why: refreshIfExpired
// has its own dedicated suite, this file only owns testCredential's dispatch
// on its outcome.
// ---------------------------------------------------------------------------

const fakeOAuthCredentialRow = {
  id: "cred-oauth-1",
  platformId: "plat-1",
  secretRef: "ref-1",
  kind: "oauth2" as const,
  // Increment 45, Slice E — `oauthMeta.providerId` no longer exists; the
  // design ("google") is now sourced from `fakePlatform.oauthProviderId`
  // via the real resolveCredentialProviderId → repos.platforms.get path.
  oauthMeta: {},
}

describe("testCredential — oauth2 refresh-ahead (30.5 bug fix)", () => {
  it("expired-but-refreshable oauth2 credential → refreshes THEN verifies against the FRESH token, not the stale one → ok", async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeOAuthCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    refreshIfExpiredMock.mockReturnValue(okAsync({ accessToken: "fresh-rotated-token" }))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-oauth-1")

    expect(result).toEqual({ ok: true, status: "ok" })
    // Non-vacuous: assert verifyCredential ran against the FRESH token,
    // never the stale store.get value (store.get is not even mocked/called
    // on this path — the oauth2 branch must not read the store directly).
    expect(verifyCredentialMock).toHaveBeenCalledWith(
      fakePlatform,
      "fresh-rotated-token",
      expect.anything(),
      { oauthProviderId: "google" },
    )
    expect(storeGetMock).not.toHaveBeenCalled()
    // Single-flighted on the credential's id, matching resolve-provider.ts.
    expect(refreshIfExpiredSingleFlightMock).toHaveBeenCalledWith(
      "cred-oauth-1",
      expect.any(Function),
    )
    expect(setVerifyStateMock).toHaveBeenCalledWith("cred-oauth-1", "ok", expect.any(Number))
  })

  it("needsReauth (refreshIfExpired → needs-reauth) → auth-failed, not ok, not a thrown 500", async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeOAuthCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    refreshIfExpiredMock.mockReturnValue(
      errAsync({ kind: "needs-reauth", platformId: "plat-1", account: "work" }),
    )
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-oauth-1")

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok:true (a verify outcome, not a thrown error)")
    expect(result.status).toBe("auth-failed")
    // verifyCredential must never run against a needs-reauth credential.
    expect(verifyCredentialMock).not.toHaveBeenCalled()
    expect(setVerifyStateMock).toHaveBeenCalledWith(
      "cred-oauth-1",
      "auth-failed",
      expect.any(Number),
    )
  })

  it("refresh SUCCEEDS (rotates the token) but the grant is revoked at the provider → verify still reports auth-failed (NOT a false ok)", async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeOAuthCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    // Refresh succeeds and rotates — this is the real "rotate-then-still-fail"
    // case: refreshIfExpired's own atomic write already committed the new
    // token; the OLD grant was simply revoked at the provider independent of
    // the refresh, so the NEW access token still fails verification.
    refreshIfExpiredMock.mockReturnValue(okAsync({ accessToken: "rotated-but-revoked-token" }))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "auth-failed" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-oauth-1")

    expect(result).toEqual({ ok: true, status: "auth-failed" })
    expect(verifyCredentialMock).toHaveBeenCalledWith(
      fakePlatform,
      "rotated-but-revoked-token",
      expect.anything(),
      { oauthProviderId: "google" },
    )
    expect(setVerifyStateMock).toHaveBeenCalledWith(
      "cred-oauth-1",
      "auth-failed",
      expect.any(Number),
    )
  })

  it("non-oauth2 credential → unchanged plain store.get path, NO refresh attempted", async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("plaintext-secret"))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")

    expect(result).toEqual({ ok: true, status: "ok" })
    expect(refreshIfExpiredMock).not.toHaveBeenCalled()
    expect(refreshIfExpiredSingleFlightMock).not.toHaveBeenCalled()
    expect(verifyCredentialMock).toHaveBeenCalledWith(
      fakePlatform,
      "plaintext-secret",
      expect.anything(),
      expect.anything(),
    )
  })

  it("oauth2 credential whose refreshed token is lost (accessToken: null) → unreachable stored-secret-missing detail, verifyCredential never called", async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeOAuthCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    refreshIfExpiredMock.mockReturnValue(okAsync({ accessToken: null }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-oauth-1")

    expect(result).toEqual({
      ok: true,
      status: "unreachable",
      detail: "stored secret missing — rotate this credential",
    })
    expect(verifyCredentialMock).not.toHaveBeenCalled()
  })
})
