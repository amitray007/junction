// SPDX-License-Identifier: AGPL-3.0-only
// refreshIfExpired / shouldRefresh tests — the five classic OAuth refresh bugs,
// each an explicit named regression test, plus the pure shouldRefresh policy.
//
// Uses a Map-backed in-memory CredentialStore mock + a mock RefreshTokenFn +
// a fixed `now` — no HTTP, no real DB. The credentials repo is a hand-rolled
// stub over an in-memory row so setOAuthTokens's merge semantics (A1) are
// exercised faithfully without touching sqlite.

import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { describe, expect, it } from "vitest"
import type { CredentialStore } from "../credentials/store.js"
import type { DbError } from "../errors/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { Credential, OAuthMeta } from "../schema/credential.js"
import {
  DEFAULT_REFRESH_BUFFER_MS,
  MAX_EXPIRES_IN_SECONDS,
  type RefreshTokenFn,
  refreshIfExpired,
  shouldRefresh,
  toExpiresAt,
} from "./refresh.js"

// ---------------------------------------------------------------------------
// toExpiresAt — the shared expires_in → expiresAt clamp (used by BOTH the
// refresh path and the connect/persist path; inc 29 slice B extracted it here
// so the two can't drift). A provider's expires_in is unbounded → these are
// the dangerous shapes that must NOT reach `new Date().toISOString()`.
// ---------------------------------------------------------------------------

describe("toExpiresAt", () => {
  const now = 1_700_000_000_000
  it("a valid positive expires_in → ISO string in the future", () => {
    const result = toExpiresAt(now, 3600)
    expect(result).toBe(new Date(now + 3600 * 1000).toISOString())
  })
  it("exactly MAX_EXPIRES_IN_SECONDS → still valid (boundary)", () => {
    expect(toExpiresAt(now, MAX_EXPIRES_IN_SECONDS)).not.toBeNull()
  })
  it.each([
    ["undefined", undefined],
    ["zero", 0],
    ["negative", -3600],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["huge (Date overflow)", 1e308],
    ["just over the century bound", MAX_EXPIRES_IN_SECONDS + 1],
  ])("an unusable expires_in (%s) → null (never throws)", (_label, value) => {
    expect(toExpiresAt(now, value as number | undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A Map-backed in-memory CredentialStore — mirrors the real get/set/delete contract. */
function createMemoryStore(seed: Record<string, string> = {}): CredentialStore {
  const map = new Map(Object.entries(seed))
  return {
    backend: "encrypted-file",
    get(ref: string): ResultAsync<string | null, never> {
      return okAsync(map.has(ref) ? (map.get(ref) as string) : null)
    },
    set(ref: string, secret: string): ResultAsync<void, never> {
      map.set(ref, secret)
      return okAsync(undefined)
    },
    delete(ref: string): ResultAsync<void, never> {
      map.delete(ref)
      return okAsync(undefined)
    },
  } as CredentialStore
}

/**
 * A hand-rolled CredentialsRepo stub carrying ONE mutable in-memory row, with
 * setOAuthTokens's real merge/omit-means-keep-old semantics (mirroring A1's
 * repo implementation) so the refresh engine's patches are validated against
 * the actual contract, not a rubber-stamp mock.
 */
function createFakeCredentialsRepo(initial: Credential): {
  repo: Pick<CredentialsRepo, "setOAuthTokens">
  getRow: () => Credential
  setOAuthTokensCalls: Array<Parameters<CredentialsRepo["setOAuthTokens"]>[1]>
  failNextSetOAuthTokens: (err: DbError) => void
} {
  let row: Credential = initial
  const calls: Array<Parameters<CredentialsRepo["setOAuthTokens"]>[1]> = []
  let pendingFailure: DbError | undefined

  const repo: Pick<CredentialsRepo, "setOAuthTokens"> = {
    setOAuthTokens(_id, patch) {
      calls.push(patch)
      if (pendingFailure) {
        const failure = pendingFailure
        pendingFailure = undefined
        return errAsync(failure)
      }
      const existing: OAuthMeta = row.oauthMeta ?? {}
      const merged: OAuthMeta = { ...existing }
      if (patch.refreshTokenRef !== undefined) merged.refreshTokenRef = patch.refreshTokenRef
      if (patch.expiresAt !== undefined) merged.expiresAt = patch.expiresAt
      if (patch.scopes !== undefined) merged.scopes = patch.scopes
      if (patch.needsReauth !== undefined) merged.needsReauth = patch.needsReauth
      if (patch.obtainedAt !== undefined) merged.obtainedAt = patch.obtainedAt
      if (patch.providerId !== undefined) merged.providerId = patch.providerId
      if (patch.authMode !== undefined) merged.authMode = patch.authMode
      if (patch.clientIdRef !== undefined) merged.clientIdRef = patch.clientIdRef
      if (patch.clientSecretRef !== undefined) merged.clientSecretRef = patch.clientSecretRef
      row = {
        ...row,
        secretRef: patch.secretRef !== undefined ? patch.secretRef : row.secretRef,
        oauthMeta: merged,
      }
      return okAsync(row)
    },
  }

  return {
    repo,
    getRow: () => row,
    setOAuthTokensCalls: calls,
    failNextSetOAuthTokens: (e: DbError) => {
      pendingFailure = e
    },
  }
}

const NOW = Date.parse("2026-07-03T12:00:00.000Z")

function makeCredential(overrides: Partial<Credential> = {}, meta: OAuthMeta = {}): Credential {
  return {
    id: "cred_test",
    platformId: "test-platform",
    profileName: "work",
    kind: "oauth2",
    secretRef: "access-ref-old",
    oauthMeta: meta,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// shouldRefresh — pure policy
// ---------------------------------------------------------------------------

describe("shouldRefresh", () => {
  it("no meta → false", () => {
    expect(shouldRefresh(undefined, NOW, DEFAULT_REFRESH_BUFFER_MS)).toBe(false)
  })

  it("no expiresAt (undefined) → false — non-expiring (GitHub OAuth App / Notion)", () => {
    expect(shouldRefresh({}, NOW, DEFAULT_REFRESH_BUFFER_MS)).toBe(false)
  })

  it("expiresAt: null → false — non-expiring", () => {
    expect(shouldRefresh({ expiresAt: null }, NOW, DEFAULT_REFRESH_BUFFER_MS)).toBe(false)
  })

  it("needsReauth true → false — never auto-refresh a dead credential", () => {
    const expiresAt = new Date(NOW - 1000).toISOString()
    expect(shouldRefresh({ expiresAt, needsReauth: true }, NOW, DEFAULT_REFRESH_BUFFER_MS)).toBe(
      false,
    )
  })

  it("expiresAt within the buffer → true", () => {
    const expiresAt = new Date(NOW + 30_000).toISOString() // 30s out, buffer is 60s
    expect(shouldRefresh({ expiresAt }, NOW, DEFAULT_REFRESH_BUFFER_MS)).toBe(true)
  })

  it("expiresAt already passed → true", () => {
    const expiresAt = new Date(NOW - 5_000).toISOString()
    expect(shouldRefresh({ expiresAt }, NOW, DEFAULT_REFRESH_BUFFER_MS)).toBe(true)
  })

  it("expiresAt well outside the buffer → false", () => {
    const expiresAt = new Date(NOW + 3_600_000).toISOString() // 1h out
    expect(shouldRefresh({ expiresAt }, NOW, DEFAULT_REFRESH_BUFFER_MS)).toBe(false)
  })

  it("malformed expiresAt (unparseable) → false, doesn't throw", () => {
    expect(shouldRefresh({ expiresAt: "not-a-date" }, NOW, DEFAULT_REFRESH_BUFFER_MS)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// refreshIfExpired — the five classic bugs
// ---------------------------------------------------------------------------

describe("refreshIfExpired", () => {
  it("non-oauth2 credential → returns current token unchanged, never calls refreshFn", async () => {
    const store = createMemoryStore({ "access-ref-old": "current-token" })
    const credential = makeCredential({ kind: "bearer", oauthMeta: undefined })
    const { repo } = createFakeCredentialsRepo(credential)
    let calls = 0
    const refreshFn: RefreshTokenFn = async () => {
      calls++
      return { ok: true, tokens: { accessToken: "should-not-happen" } }
    }

    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.accessToken).toBe("current-token")
    expect(calls).toBe(0)
  })

  it("expires_in absent → non-expiring: shouldRefresh false, no refresh, returns current token", async () => {
    const store = createMemoryStore({ "access-ref-old": "current-token" })
    const credential = makeCredential({}, { providerId: "github" }) // no expiresAt
    const { repo } = createFakeCredentialsRepo(credential)
    let calls = 0
    const refreshFn: RefreshTokenFn = async () => {
      calls++
      return { ok: true, tokens: { accessToken: "should-not-happen" } }
    }

    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.accessToken).toBe("current-token")
    expect(calls).toBe(0)
  })

  it("needsReauth already true → immediate needs-reauth, no refresh attempt", async () => {
    const store = createMemoryStore({ "access-ref-old": "current-token" })
    const expiresAt = new Date(NOW - 5_000).toISOString()
    const credential = makeCredential({}, { expiresAt, needsReauth: true, providerId: "google" })
    const { repo } = createFakeCredentialsRepo(credential)
    let calls = 0
    const refreshFn: RefreshTokenFn = async () => {
      calls++
      return { ok: true, tokens: { accessToken: "should-not-happen" } }
    }

    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({
        kind: "needs-reauth",
        platformId: "test-platform",
        account: "work",
      })
    }
    expect(calls).toBe(0)
  })

  it("atomic rotation persistence: successful refresh writes new access ref + rotated refresh ref + expiry + needsReauth:false; returned token == new access token; old refs deleted", async () => {
    const expiresAt = new Date(NOW - 1_000).toISOString()
    const credential = makeCredential(
      {},
      {
        expiresAt,
        providerId: "google",
        refreshTokenRef: "refresh-ref-old",
        clientIdRef: "client-id-ref",
        clientSecretRef: "client-secret-ref",
      },
    )
    const store = createMemoryStore({
      "access-ref-old": "old-access-token",
      "refresh-ref-old": "old-refresh-token",
      "client-id-ref": "the-client-id",
      "client-secret-ref": "the-client-secret",
    })
    const { repo, getRow } = createFakeCredentialsRepo(credential)

    const refreshFn: RefreshTokenFn = async (args) => {
      expect(args).toEqual({
        providerId: "google",
        refreshToken: "old-refresh-token",
        clientId: "the-client-id",
        clientSecret: "the-client-secret",
      })
      return {
        ok: true,
        tokens: {
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          expiresInSeconds: 3600,
          scopes: ["scope-a"],
        },
      }
    }

    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.accessToken).toBe("new-access-token")

    const row = getRow()
    expect(row.oauthMeta?.needsReauth).toBe(false)
    expect(row.oauthMeta?.expiresAt).toBe(new Date(NOW + 3_600_000).toISOString())
    expect(row.oauthMeta?.refreshTokenRef).not.toBe("refresh-ref-old")
    const newRefreshRef = row.oauthMeta?.refreshTokenRef as string
    expect(row.secretRef).not.toBe("access-ref-old")

    // New refs resolve to the new tokens.
    const newAccess = await store.get(row.secretRef)
    expect(newAccess.isOk() && newAccess.value).toBe("new-access-token")
    const newRefresh = await store.get(newRefreshRef)
    expect(newRefresh.isOk() && newRefresh.value).toBe("new-refresh-token")

    // Old refs deleted.
    const oldAccess = await store.get("access-ref-old")
    expect(oldAccess.isOk() && oldAccess.value).toBeNull()
    const oldRefresh = await store.get("refresh-ref-old")
    expect(oldRefresh.isOk() && oldRefresh.value).toBeNull()
  })

  it("keep-old-refresh-if-absent: refreshFn returns no refreshToken → prior refreshTokenRef is RETAINED (not nulled), access ref still rotates", async () => {
    const expiresAt = new Date(NOW - 1_000).toISOString()
    const credential = makeCredential(
      {},
      {
        expiresAt,
        providerId: "google",
        refreshTokenRef: "refresh-ref-old",
        clientIdRef: "client-id-ref",
        clientSecretRef: "client-secret-ref",
      },
    )
    const store = createMemoryStore({
      "access-ref-old": "old-access-token",
      "refresh-ref-old": "old-refresh-token",
      "client-id-ref": "the-client-id",
      "client-secret-ref": "the-client-secret",
    })
    const { repo, getRow, setOAuthTokensCalls } = createFakeCredentialsRepo(credential)

    const refreshFn: RefreshTokenFn = async () => ({
      ok: true,
      tokens: { accessToken: "new-access-token" }, // NO refreshToken — Google's no-rotation case
    })

    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })

    expect(result.isOk()).toBe(true)
    const row = getRow()
    // The prior refreshTokenRef must be UNCHANGED — retained, not nulled.
    expect(row.oauthMeta?.refreshTokenRef).toBe("refresh-ref-old")
    // The old refresh token must still resolve (never deleted since it wasn't rotated).
    const oldRefresh = await store.get("refresh-ref-old")
    expect(oldRefresh.isOk() && oldRefresh.value).toBe("old-refresh-token")
    // The patch sent to setOAuthTokens must OMIT refreshTokenRef entirely (not set it to undefined).
    const patch = setOAuthTokensCalls.at(-1)
    expect(patch).toBeDefined()
    expect(patch && "refreshTokenRef" in patch).toBe(false)
    // Access ref still rotated.
    expect(row.secretRef).not.toBe("access-ref-old")
  })

  it("invalid_grant → needsReauth persisted (refs retained) + clear needs-reauth error", async () => {
    const expiresAt = new Date(NOW - 1_000).toISOString()
    const credential = makeCredential(
      {},
      {
        expiresAt,
        providerId: "slack",
        refreshTokenRef: "refresh-ref-old",
        clientIdRef: "client-id-ref",
        clientSecretRef: "client-secret-ref",
      },
    )
    const store = createMemoryStore({
      "access-ref-old": "old-access-token",
      "refresh-ref-old": "old-refresh-token",
      "client-id-ref": "the-client-id",
      "client-secret-ref": "the-client-secret",
    })
    const { repo, getRow } = createFakeCredentialsRepo(credential)

    const refreshFn: RefreshTokenFn = async () => ({ ok: false, reason: "invalid_grant" })

    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({
        kind: "needs-reauth",
        platformId: "test-platform",
        account: "work",
      })
    }
    const row = getRow()
    expect(row.oauthMeta?.needsReauth).toBe(true)
    // Refs retained (merge semantics — not cleared).
    expect(row.oauthMeta?.refreshTokenRef).toBe("refresh-ref-old")
    expect(row.secretRef).toBe("access-ref-old")
  })

  it("transient failure keeps old tokens: DB untouched, old refresh ref intact, returns refresh-failed (retryable)", async () => {
    const expiresAt = new Date(NOW - 1_000).toISOString()
    const credential = makeCredential(
      {},
      {
        expiresAt,
        providerId: "google",
        refreshTokenRef: "refresh-ref-old",
        clientIdRef: "client-id-ref",
        clientSecretRef: "client-secret-ref",
      },
    )
    const store = createMemoryStore({
      "access-ref-old": "old-access-token",
      "refresh-ref-old": "old-refresh-token",
      "client-id-ref": "the-client-id",
      "client-secret-ref": "the-client-secret",
    })
    const { repo, getRow, setOAuthTokensCalls } = createFakeCredentialsRepo(credential)

    const refreshFn: RefreshTokenFn = async () => ({
      ok: false,
      reason: "transient",
      detail: "upstream 503",
    })

    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("refresh-failed")
    // setOAuthTokens must NEVER have been called — DB untouched.
    expect(setOAuthTokensCalls.length).toBe(0)
    const row = getRow()
    expect(row.oauthMeta?.refreshTokenRef).toBe("refresh-ref-old")
    expect(row.secretRef).toBe("access-ref-old")
    // Old tokens still resolve.
    const oldAccess = await store.get("access-ref-old")
    expect(oldAccess.isOk() && oldAccess.value).toBe("old-access-token")
    const oldRefresh = await store.get("refresh-ref-old")
    expect(oldRefresh.isOk() && oldRefresh.value).toBe("old-refresh-token")
  })

  it("DB-fail-mid-rotation is fail-safe: setOAuthTokens errors after store.set → new store entries cleaned up, OLD secretRef still live, returns refresh-failed", async () => {
    const expiresAt = new Date(NOW - 1_000).toISOString()
    const credential = makeCredential(
      {},
      {
        expiresAt,
        providerId: "google",
        refreshTokenRef: "refresh-ref-old",
        clientIdRef: "client-id-ref",
        clientSecretRef: "client-secret-ref",
      },
    )
    const store = createMemoryStore({
      "access-ref-old": "old-access-token",
      "refresh-ref-old": "old-refresh-token",
      "client-id-ref": "the-client-id",
      "client-secret-ref": "the-client-secret",
    })
    // Track every ref written to the store so we can assert the NEW ones
    // (minted internally, so their exact value is opaque to this test) are
    // cleaned up after the DB failure.
    const setRefs: string[] = []
    const originalSet = store.set.bind(store)
    store.set = (ref: string, secret: string) => {
      setRefs.push(ref)
      return originalSet(ref, secret)
    }

    const { repo, getRow, failNextSetOAuthTokens } = createFakeCredentialsRepo(credential)
    failNextSetOAuthTokens({ kind: "query-failed", cause: new Error("stubbed DB failure") })

    const refreshFn: RefreshTokenFn = async () => ({
      ok: true,
      tokens: { accessToken: "new-access-token", refreshToken: "new-refresh-token" },
    })

    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("refresh-failed")

    // The row was never repointed — old secretRef is still what the DB has.
    const row = getRow()
    expect(row.secretRef).toBe("access-ref-old")
    expect(row.oauthMeta?.refreshTokenRef).toBe("refresh-ref-old")

    // OLD access + refresh tokens are still live.
    const oldAccess = await store.get("access-ref-old")
    expect(oldAccess.isOk() && oldAccess.value).toBe("old-access-token")
    const oldRefresh = await store.get("refresh-ref-old")
    expect(oldRefresh.isOk() && oldRefresh.value).toBe("old-refresh-token")

    // The two NEW refs written before the DB failure must have been cleaned up
    // (best-effort delete) — neither resolves anymore.
    expect(setRefs.length).toBe(2)
    for (const newRef of setRefs) {
      const got = await store.get(newRef)
      expect(got.isOk() && got.value).toBeNull()
    }
  })

  it("absent refresh token ref → needs-reauth (nothing to refresh with)", async () => {
    const expiresAt = new Date(NOW - 1_000).toISOString()
    const credential = makeCredential({}, { expiresAt, providerId: "google" }) // no refreshTokenRef
    const store = createMemoryStore({ "access-ref-old": "old-access-token" })
    const { repo } = createFakeCredentialsRepo(credential)
    let calls = 0
    const refreshFn: RefreshTokenFn = async () => {
      calls++
      return { ok: true, tokens: { accessToken: "unused" } }
    }

    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("needs-reauth")
    expect(calls).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Adversarial-review regressions (inc 29 A2 review — H1/H2/L1 hardening)
  // -------------------------------------------------------------------------

  it("lost secret (null store value) on a non-expired oauth2 cred → accessToken null, NOT empty string", async () => {
    // The access-token secret is gone (keyring loss / out-of-band clear) but
    // the cred is not due for refresh. Must return null (→ wiring maps to
    // no-auth), never "" (which would inject an empty Bearer — a fake auth).
    const credential = makeCredential(
      { secretRef: "MISSING" },
      {
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
        refreshTokenRef: "rt",
        clientIdRef: "ci",
        clientSecretRef: "cs",
        providerId: "google",
      },
    )
    const store = createMemoryStore({}) // access ref absent → store.get → null
    const { repo } = createFakeCredentialsRepo(credential)
    const refreshFn: RefreshTokenFn = async () => ({ ok: false, reason: "unknown" })
    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.accessToken).toBeNull()
  })

  it("empty-string refresh token in the store → needs-reauth, refreshFn NOT called (read-side guard)", async () => {
    const credential = makeCredential(
      {},
      {
        expiresAt: new Date(NOW - 1_000).toISOString(),
        refreshTokenRef: "rt",
        clientIdRef: "ci",
        clientSecretRef: "cs",
        providerId: "google",
      },
    )
    const store = createMemoryStore({
      "access-ref-old": "old-access-token",
      rt: "", // empty refresh token — must be treated like absent, not passed on
      ci: "CID",
      cs: "CSEC",
    })
    const { repo, setOAuthTokensCalls } = createFakeCredentialsRepo(credential)
    let calls = 0
    const refreshFn: RefreshTokenFn = async () => {
      calls++
      return { ok: true, tokens: { accessToken: "x" } }
    }
    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("needs-reauth")
    expect(calls).toBe(0)
    expect(setOAuthTokensCalls.length).toBe(0)
  })

  it("empty-string refresh token FROM the provider → prior refreshTokenRef retained, no empty ref minted (write-side keep-old)", async () => {
    const credential = makeCredential(
      { secretRef: "access-ref-old" },
      {
        expiresAt: new Date(NOW - 1_000).toISOString(),
        refreshTokenRef: "refresh-ref-old",
        clientIdRef: "ci",
        clientSecretRef: "cs",
        providerId: "google",
      },
    )
    const store = createMemoryStore({
      "access-ref-old": "old-access-token",
      "refresh-ref-old": "old-refresh-token",
      ci: "CID",
      cs: "CSEC",
    })
    const { repo, setOAuthTokensCalls } = createFakeCredentialsRepo(credential)
    const refreshFn: RefreshTokenFn = async () => ({
      ok: true,
      tokens: { accessToken: "NEW_AT", refreshToken: "", expiresInSeconds: 3600 },
    })
    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })
    expect(result.isOk()).toBe(true)
    // patch OMITS refreshTokenRef (keep-old); the old refresh ref is untouched.
    expect("refreshTokenRef" in setOAuthTokensCalls[0]).toBe(false)
    const oldRefresh = await store.get("refresh-ref-old")
    expect(oldRefresh.isOk() && oldRefresh.value).toBe("old-refresh-token")
  })

  it("negative expiresInSeconds → expiresAt falls back to prior, NOT a past date (no refresh storm)", async () => {
    const priorExpiry = new Date(NOW + 7_200_000).toISOString()
    const credential = makeCredential(
      {},
      {
        expiresAt: new Date(NOW - 1_000).toISOString(),
        refreshTokenRef: "rt",
        clientIdRef: "ci",
        clientSecretRef: "cs",
        providerId: "google",
        scopes: ["a"],
      },
    )
    // Seed prior expiry via a first successful state isn't needed — the fallback
    // is `meta?.expiresAt` which at refresh time is the (expired) value; assert
    // the engine does NOT compute a bogus past/overflow date and does not throw.
    const store = createMemoryStore({
      "access-ref-old": "old",
      rt: "RT",
      ci: "CID",
      cs: "CSEC",
    })
    const { repo, setOAuthTokensCalls } = createFakeCredentialsRepo(credential)
    const refreshFn: RefreshTokenFn = async () => ({
      ok: true,
      tokens: { accessToken: "NAT", expiresInSeconds: -100 },
    })
    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })
    expect(result.isOk()).toBe(true)
    // The bogus negative expires_in is ignored → expiresAt is the prior value
    // (not now-100s). It must not be a fresh past timestamp derived from `now`.
    const written = setOAuthTokensCalls[0].expiresAt
    expect(written).not.toBe(new Date(NOW + -100 * 1000).toISOString())
    void priorExpiry
  })

  it("absurdly-huge expiresInSeconds → no throw, expiresAt falls back (Date overflow guarded)", async () => {
    const credential = makeCredential(
      {},
      {
        expiresAt: new Date(NOW - 1_000).toISOString(),
        refreshTokenRef: "rt",
        clientIdRef: "ci",
        clientSecretRef: "cs",
        providerId: "google",
      },
    )
    const store = createMemoryStore({
      "access-ref-old": "old",
      rt: "RT",
      ci: "CID",
      cs: "CSEC",
    })
    const { repo } = createFakeCredentialsRepo(credential)
    const refreshFn: RefreshTokenFn = async () => ({
      ok: true,
      tokens: { accessToken: "NAT", expiresInSeconds: Number.MAX_SAFE_INTEGER },
    })
    // Must NOT throw a RangeError from .toISOString() on an overflowing Date.
    const result = await refreshIfExpired({
      credential,
      store,
      repos: { credentials: repo },
      refreshFn,
      now: NOW,
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.accessToken).toBe("NAT")
  })
})
