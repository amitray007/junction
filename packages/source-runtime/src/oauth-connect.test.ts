// SPDX-License-Identifier: AGPL-3.0-only
// oauth-connect.ts tests — the browser auth-code+PKCE, device-code, and
// persist flows (increment 29, slice B). Mocks arctic + fetch (no real HTTP).
//
// Adversarial proof (mandatory per the method file's security gate): seed
// sentinel access/refresh/client_secret values and assert they NEVER appear
// in any error/return value, the persisted DB row, or the oauth_meta JSON —
// only ref-* handles are visible past persistOAuthTokens.

import {
  ok as coreOk,
  createRepositories,
  getDatabase,
  getPaths,
  getProvider,
  ResultAsync,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { describe, expect, it, vi } from "vitest"
import {
  buildAuthorizeUrl,
  deviceAuthorize,
  devicePoll,
  exchangeCode,
  persistOAuthTokens,
} from "./oauth-connect.js"

const validateAuthorizationCode = vi.fn()

vi.mock("arctic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("arctic")>()
  return {
    ...actual,
    OAuth2Client: vi.fn().mockImplementation(function MockOAuth2Client(
      this: {
        createAuthorizationURL: typeof actual.OAuth2Client.prototype.createAuthorizationURL
        createAuthorizationURLWithPKCE: typeof actual.OAuth2Client.prototype.createAuthorizationURLWithPKCE
        validateAuthorizationCode: typeof validateAuthorizationCode
      },
      clientId: string,
      clientPassword: string | null,
      redirectURI: string | null,
    ) {
      const real = new actual.OAuth2Client(clientId, clientPassword, redirectURI)
      this.createAuthorizationURL = real.createAuthorizationURL.bind(real)
      this.createAuthorizationURLWithPKCE = real.createAuthorizationURLWithPKCE.bind(real)
      this.validateAuthorizationCode = validateAuthorizationCode
    }),
  }
})

const SENTINEL_ACCESS = "sentinel-access-token-do-not-leak"
const SENTINEL_REFRESH = "sentinel-refresh-token-do-not-leak"
const SENTINEL_CLIENT_SECRET = "sentinel-client-secret-do-not-leak"

// ---------------------------------------------------------------------------
// buildAuthorizeUrl
// ---------------------------------------------------------------------------

describe("buildAuthorizeUrl", () => {
  it("google: produces an S256 PKCE URL with state, code_challenge, offline access_type + consent, and scopes", () => {
    const provider = getProvider("google")
    expect(provider).toBeDefined()
    if (!provider) return

    const result = buildAuthorizeUrl({
      provider,
      clientId: "cid",
      redirectUri: "http://127.0.0.1:12345/",
      scopes: ["profile", "email"],
    })

    const url = new URL(result.url)
    expect(url.searchParams.get("state")).toBe(result.state)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBeTruthy()
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("scope")).toBe("profile email")
    expect(result.codeVerifier.length).toBeGreaterThan(0)
    // state/codeVerifier are per-flow — two calls never reuse either.
    const second = buildAuthorizeUrl({
      provider,
      clientId: "cid",
      redirectUri: "http://127.0.0.1:12345/",
      scopes: ["profile"],
    })
    expect(second.state).not.toBe(result.state)
    expect(second.codeVerifier).not.toBe(result.codeVerifier)
  })

  it("slack: uses the comma scope separator", () => {
    const provider = getProvider("slack")
    expect(provider).toBeDefined()
    if (!provider) return
    const result = buildAuthorizeUrl({
      provider,
      clientId: "cid",
      redirectUri: "http://127.0.0.1:4321/oauth/callback",
      scopes: ["channels:read", "chat:write"],
    })
    const url = new URL(result.url)
    expect(url.searchParams.get("scope")).toBe("channels:read,chat:write")
  })

  it("round-trips: the returned state/codeVerifier are exactly what the caller must stash for exchangeCode", () => {
    const provider = getProvider("github-app")
    expect(provider).toBeDefined()
    if (!provider) return
    const result = buildAuthorizeUrl({
      provider,
      clientId: "cid",
      redirectUri: "http://127.0.0.1:4321/oauth/callback",
      scopes: [],
    })
    // Simulate stashing state -> codeVerifier, then retrieving it at callback time.
    const pending = new Map([[result.state, result.codeVerifier]])
    expect(pending.get(result.state)).toBe(result.codeVerifier)
  })
})

// ---------------------------------------------------------------------------
// exchangeCode
// ---------------------------------------------------------------------------

describe("exchangeCode", () => {
  it("normalizes a successful default-shape response", async () => {
    const provider = getProvider("github-app")
    expect(provider).toBeDefined()
    if (!provider) return

    validateAuthorizationCode.mockResolvedValueOnce({
      data: { access_token: "tok", refresh_token: "reftok", expires_in: 3600, scope: "repo" },
    })

    const result = await exchangeCode({
      provider,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:4321/oauth/callback",
      code: "auth-code",
      codeVerifier: "verifier",
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual({
        accessToken: "tok",
        refreshToken: "reftok",
        expiresInSeconds: 3600,
        scopes: ["repo"],
      })
    }
  })

  it("slack {ok:false}-at-200 is rejected as a typed error, not a fake success", async () => {
    const provider = getProvider("slack")
    expect(provider).toBeDefined()
    if (!provider) return

    validateAuthorizationCode.mockResolvedValueOnce({
      data: { ok: false, error: "invalid_code" },
    })

    const result = await exchangeCode({
      provider,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:4321/oauth/callback",
      code: "auth-code",
      codeVerifier: "verifier",
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("exchange-failed")
  })

  it("slack {ok:true} with a real access_token normalizes correctly", async () => {
    const provider = getProvider("slack")
    expect(provider).toBeDefined()
    if (!provider) return

    validateAuthorizationCode.mockResolvedValueOnce({
      data: { ok: true, access_token: "xoxb-tok", scope: "channels:read,chat:write" },
    })

    const result = await exchangeCode({
      provider,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:4321/oauth/callback",
      code: "auth-code",
      codeVerifier: "verifier",
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.accessToken).toBe("xoxb-tok")
      expect(result.value.scopes).toEqual(["channels:read", "chat:write"])
    }
  })

  it("a thrown OAuth2RequestError(invalid_grant) maps to exchange-failed/invalid_grant, never leaking the sentinel code text", async () => {
    const provider = getProvider("google")
    expect(provider).toBeDefined()
    if (!provider) return
    const { OAuth2RequestError } = await import("arctic")
    validateAuthorizationCode.mockRejectedValueOnce(
      new OAuth2RequestError("invalid_grant", SENTINEL_REFRESH, null, null),
    )

    const result = await exchangeCode({
      provider,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:1234/",
      code: "auth-code",
      codeVerifier: "verifier",
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("exchange-failed")
      if (result.error.kind === "exchange-failed") expect(result.error.reason).toBe("invalid_grant")
    }
    expect(JSON.stringify(result)).not.toContain(SENTINEL_REFRESH)
  })
})

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

describe("deviceAuthorize / devicePoll", () => {
  it("device-not-supported for a provider without deviceAuthorizationUrl", async () => {
    const provider = getProvider("slack")
    expect(provider).toBeDefined()
    if (!provider) return
    const result = await deviceAuthorize({ provider, clientId: "cid", scopes: [] })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("device-not-supported")
  })

  it("deviceAuthorize parses a valid device response", async () => {
    const provider = getProvider("google")
    expect(provider).toBeDefined()
    if (!provider) return

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: "devcode",
        user_code: "ABCD-EFGH",
        verification_uri: "https://google.com/device",
        interval: 5,
        expires_in: 1800,
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await deviceAuthorize({ provider, clientId: "cid", scopes: ["email"] })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.userCode).toBe("ABCD-EFGH")
      expect(result.value.intervalSeconds).toBe(5)
    }
    vi.unstubAllGlobals()
  })

  it("devicePoll: authorization_pending / slow_down / access_denied / expired_token map to typed device-* errors", async () => {
    const provider = getProvider("google")
    expect(provider).toBeDefined()
    if (!provider) return

    const cases: Array<[string, string]> = [
      ["authorization_pending", "device-pending"],
      ["slow_down", "device-slow-down"],
      ["access_denied", "device-denied"],
      ["expired_token", "device-expired"],
    ]

    for (const [errorCode, expectedKind] of cases) {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        status: 400,
        json: async () => ({ error: errorCode }),
      })
      vi.stubGlobal("fetch", fetchMock)

      const result = await devicePoll({
        provider,
        clientId: "cid",
        clientSecret: "csecret",
        deviceCode: "devcode",
      })
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe(expectedKind)
      vi.unstubAllGlobals()
    }
  })

  it("devicePoll: success normalizes tokens", async () => {
    const provider = getProvider("google")
    expect(provider).toBeDefined()
    if (!provider) return

    const fetchMock = vi.fn().mockResolvedValueOnce({
      status: 200,
      json: async () => ({ access_token: "tok", refresh_token: "reftok", expires_in: 3600 }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await devicePoll({
      provider,
      clientId: "cid",
      clientSecret: "csecret",
      deviceCode: "devcode",
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.accessToken).toBe("tok")
    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// persistOAuthTokens — atomicity + no-leak
// ---------------------------------------------------------------------------

describe("persistOAuthTokens", () => {
  it("mode create: stores access+refresh+client id/secret as refs, no raw token in the DB row / oauth_meta / anywhere but the store", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = {
        id: "test-platform",
        kind: "mcp" as const,
        displayName: "Test",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
      }
      await repos.platforms.upsert(platform)

      const storeMap = new Map<string, string>()
      const store = {
        backend: "encrypted-file" as const,
        get: (ref: string) =>
          new ResultAsync(
            Promise.resolve(coreOk(storeMap.has(ref) ? (storeMap.get(ref) as string) : null)),
          ),
        set: (ref: string, value: string) => {
          storeMap.set(ref, value)
          return new ResultAsync(Promise.resolve(coreOk(undefined)))
        },
        delete: (ref: string) => {
          storeMap.delete(ref)
          return new ResultAsync(Promise.resolve(coreOk(undefined)))
        },
      }

      const result = await persistOAuthTokens({
        repos,
        store,
        tokens: {
          accessToken: SENTINEL_ACCESS,
          refreshToken: SENTINEL_REFRESH,
          expiresInSeconds: 3600,
          scopes: ["repo"],
        },
        providerId: "github-app",
        authMode: "authorization_code",
        clientId: "my-client-id",
        clientSecret: SENTINEL_CLIENT_SECRET,
        now: Date.now(),
        mode: "create",
        platformId: "test-platform",
        account: "work",
      })

      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      const credential = result.value

      // The DB row (as returned + as re-fetched) never carries a raw token.
      expect(JSON.stringify(credential)).not.toContain(SENTINEL_ACCESS)
      expect(JSON.stringify(credential)).not.toContain(SENTINEL_REFRESH)
      expect(JSON.stringify(credential)).not.toContain(SENTINEL_CLIENT_SECRET)

      const refetch = await repos.credentials.get(credential.id)
      expect(refetch.isOk()).toBe(true)
      if (refetch.isOk()) {
        expect(JSON.stringify(refetch.value)).not.toContain(SENTINEL_ACCESS)
        expect(JSON.stringify(refetch.value)).not.toContain(SENTINEL_REFRESH)
        expect(JSON.stringify(refetch.value)).not.toContain(SENTINEL_CLIENT_SECRET)
      }

      // The secrets DO live behind the refs in the store.
      expect(await store.get(credential.secretRef).then((r) => (r.isOk() ? r.value : null))).toBe(
        SENTINEL_ACCESS,
      )
      const refreshRef = credential.oauthMeta?.refreshTokenRef
      expect(refreshRef).toBeDefined()
      if (refreshRef !== undefined) {
        expect(await store.get(refreshRef).then((r) => (r.isOk() ? r.value : null))).toBe(
          SENTINEL_REFRESH,
        )
      }
      const clientSecretRef = credential.oauthMeta?.clientSecretRef
      expect(clientSecretRef).toBeDefined()
      if (clientSecretRef !== undefined) {
        expect(await store.get(clientSecretRef).then((r) => (r.isOk() ? r.value : null))).toBe(
          SENTINEL_CLIENT_SECRET,
        )
      }

      expect(credential.oauthMeta?.needsReauth).toBe(false)
      expect(credential.oauthMeta?.providerId).toBe("github-app")
    })
  })

  it("mode update: repoints an existing credential's refs and best-effort deletes the OLD refs (not the new ones)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = {
        id: "test-platform-2",
        kind: "mcp" as const,
        displayName: "Test2",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
      }
      await repos.platforms.upsert(platform)

      const storeMap = new Map<string, string>([
        ["old-access-ref", "old-access"],
        ["old-refresh-ref", "old-refresh"],
        ["old-client-id-ref", "old-client-id"],
        ["old-client-secret-ref", "old-client-secret"],
      ])
      const store = {
        backend: "encrypted-file" as const,
        get: (ref: string) =>
          new ResultAsync(
            Promise.resolve(coreOk(storeMap.has(ref) ? (storeMap.get(ref) as string) : null)),
          ),
        set: (ref: string, value: string) => {
          storeMap.set(ref, value)
          return new ResultAsync(Promise.resolve(coreOk(undefined)))
        },
        delete: (ref: string) => {
          storeMap.delete(ref)
          return new ResultAsync(Promise.resolve(coreOk(undefined)))
        },
      }

      const createResult = await repos.credentials.create({
        id: "cred-reconnect-test",
        platformId: "test-platform-2",
        profileName: "work",
        kind: "oauth2",
        secretRef: "old-access-ref",
        oauthMeta: {
          refreshTokenRef: "old-refresh-ref",
          clientIdRef: "old-client-id-ref",
          clientSecretRef: "old-client-secret-ref",
          providerId: "github-app",
          authMode: "authorization_code",
          needsReauth: true,
        },
      })
      expect(createResult.isOk()).toBe(true)

      const result = await persistOAuthTokens({
        repos,
        store,
        tokens: { accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 3600 },
        providerId: "github-app",
        authMode: "authorization_code",
        clientId: "new-client-id",
        clientSecret: "new-client-secret",
        now: Date.now(),
        mode: "update",
        credentialId: "cred-reconnect-test",
      })

      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.oauthMeta?.needsReauth).toBe(false)

      // Old refs are gone (best-effort delete after successful repoint).
      expect(storeMap.has("old-access-ref")).toBe(false)
      expect(storeMap.has("old-refresh-ref")).toBe(false)
      expect(storeMap.has("old-client-id-ref")).toBe(false)
      expect(storeMap.has("old-client-secret-ref")).toBe(false)

      // New refs hold the new values.
      expect(storeMap.get(result.value.secretRef)).toBe("new-access")
      const newRefreshRef = result.value.oauthMeta?.refreshTokenRef
      expect(newRefreshRef).toBeDefined()
      if (newRefreshRef !== undefined) expect(storeMap.get(newRefreshRef)).toBe("new-refresh")
    })
  })

  it("a DB failure on create leaves NO orphaned store writes (cleanup runs)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const storeMap = new Map<string, string>()
      const store = {
        backend: "encrypted-file" as const,
        get: (ref: string) =>
          new ResultAsync(
            Promise.resolve(coreOk(storeMap.has(ref) ? (storeMap.get(ref) as string) : null)),
          ),
        set: (ref: string, value: string) => {
          storeMap.set(ref, value)
          return new ResultAsync(Promise.resolve(coreOk(undefined)))
        },
        delete: (ref: string) => {
          storeMap.delete(ref)
          return new ResultAsync(Promise.resolve(coreOk(undefined)))
        },
      }

      // platformId "" fails CredentialSchema validation (PlatformIdSchema.min(1))
      // BEFORE repos.credentials.create is even called — proves persistOAuthTokens
      // cleans up its OWN just-written store entries on any downstream failure.
      const result = await persistOAuthTokens({
        repos,
        store,
        tokens: { accessToken: "tok", refreshToken: "reftok" },
        providerId: "github-app",
        authMode: "authorization_code",
        clientId: "cid",
        clientSecret: "csecret",
        now: Date.now(),
        mode: "create",
        platformId: "",
        account: "work",
      })

      expect(result.isErr()).toBe(true)
      expect(storeMap.size).toBe(0)
    })
  })

  // Regression (inc 29 slice B review — adversarial + correctness): a provider
  // token response with an unbounded `expires_in` (huge/non-finite → Date
  // overflow RangeError; negative → past expiry / refresh storm) must NEVER
  // throw out of the Result-returning fn (which would escape as a rejection at
  // the caller's await + orphan the just-written refs). toExpiresAt bounds it →
  // graceful null expiry, and the whole flow still settles to a Result.
  it.each([
    1e308,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    -3600,
    0,
  ])("mode create: adversarial expiresInSeconds=%p → no throw/reject, expiresAt null, no orphaned refs", async (badExpiry) => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)
      await repos.platforms.upsert({
        id: "adv-platform",
        kind: "mcp" as const,
        displayName: "Adv",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
      })

      const storeMap = new Map<string, string>()
      const store = {
        backend: "encrypted-file" as const,
        get: (ref: string) => new ResultAsync(Promise.resolve(coreOk(storeMap.get(ref) ?? null))),
        set: (ref: string, value: string) => {
          storeMap.set(ref, value)
          return new ResultAsync(Promise.resolve(coreOk(undefined)))
        },
        delete: (ref: string) => {
          storeMap.delete(ref)
          return new ResultAsync(Promise.resolve(coreOk(undefined)))
        },
      }

      // Must not throw/reject regardless of the adversarial expiry.
      const result = await persistOAuthTokens({
        repos,
        store,
        tokens: {
          accessToken: SENTINEL_ACCESS,
          refreshToken: SENTINEL_REFRESH,
          expiresInSeconds: badExpiry,
          scopes: ["repo"],
        },
        providerId: "github",
        authMode: "authorization_code",
        clientId: "cid",
        clientSecret: SENTINEL_CLIENT_SECRET,
        now: Date.now(),
        mode: "create",
        platformId: "adv-platform",
        account: `adv-${badExpiry}`,
      })

      // A settled Result (Ok here — the bad expiry is neutralized, not fatal).
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      // Unusable expiry → null (non-expiring), never a past/overflowing date.
      expect(result.value.oauthMeta?.expiresAt ?? null).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// deviceAuthorize — 200-with-null-body must not throw out of the Result fn
// ---------------------------------------------------------------------------

describe("deviceAuthorize null-body guard", () => {
  it("a 200 response whose JSON body is literal null → typed Err, never a thrown TypeError", async () => {
    const provider = getProvider("google")
    expect(provider).toBeDefined()
    if (!provider) return
    const realFetch = globalThis.fetch
    // biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub for the test
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => null })) as any
    try {
      const result = await deviceAuthorize({ provider, clientId: "cid", scopes: ["x"] })
      expect(result.isErr()).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
