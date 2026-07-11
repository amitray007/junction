// SPDX-License-Identifier: AGPL-3.0-only
// oauthRefreshFn tests — the arctic-backed RefreshTokenFn (increment 29,
// slice B). Mocks arctic's OAuth2Client (no real HTTP) and asserts:
//   - empty/unknown providerId hard-fails to reason "unknown", never throws.
//   - a successful refresh normalizes guarded accessor reads correctly.
//   - invalid_grant / transient / unknown failures map correctly.
//   - a sentinel refresh token NEVER appears in any returned `detail` (the
//     no-leak adversarial proof).

import { ArcticFetchError, OAuth2RequestError } from "arctic"
import { describe, expect, it, vi } from "vitest"
import { oauthRefreshFn } from "./oauth-refresh-fn.js"

// vi.hoisted so the mock fn exists BEFORE the hoisted vi.mock factory runs —
// vi.mock is lifted above a plain `const`, so a bare closure over it risks a
// temporal-dead-zone ReferenceError (matches resolve-provider.test.ts).
const { refreshAccessToken } = vi.hoisted(() => ({ refreshAccessToken: vi.fn() }))

vi.mock("arctic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("arctic")>()
  return {
    ...actual,
    OAuth2Client: vi.fn().mockImplementation(function MockOAuth2Client(this: {
      refreshAccessToken: typeof refreshAccessToken
    }) {
      this.refreshAccessToken = refreshAccessToken
    }),
  }
})

const SENTINEL_REFRESH_TOKEN = "sentinel-refresh-token-do-not-leak-9f3a"

describe("oauthRefreshFn — hard-fail on empty/unknown providerId", () => {
  it("empty providerId → reason unknown, never throws", async () => {
    const result = await oauthRefreshFn({
      providerId: "",
      refreshToken: SENTINEL_REFRESH_TOKEN,
      clientId: "cid",
      clientSecret: "csecret",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })

  it("whitespace-only providerId → reason unknown", async () => {
    const result = await oauthRefreshFn({
      providerId: "   ",
      refreshToken: SENTINEL_REFRESH_TOKEN,
      clientId: "cid",
      clientSecret: "csecret",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })

  it("unknown providerId → reason unknown, never throws", async () => {
    const result = await oauthRefreshFn({
      providerId: "not-a-real-provider",
      refreshToken: SENTINEL_REFRESH_TOKEN,
      clientId: "cid",
      clientSecret: "csecret",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })
})

describe("oauthRefreshFn — success path", () => {
  it("normalizes accessToken/refreshToken/expiry/scopes from guarded accessors", async () => {
    refreshAccessToken.mockResolvedValueOnce({
      data: {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        scope: "read write",
      },
      accessToken: () => "new-access-token",
      hasRefreshToken: () => true,
      refreshToken: () => "new-refresh-token",
      accessTokenExpiresInSeconds: () => 3600,
      hasScopes: () => true,
      scopes: () => ["read", "write"],
    })

    const result = await oauthRefreshFn({
      providerId: "github-app",
      refreshToken: "old-refresh-token",
      clientId: "cid",
      clientSecret: "csecret",
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tokens).toEqual({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresInSeconds: 3600,
        scopes: ["read", "write"],
      })
    }
  })

  it("omits refreshToken/expiry/scopes when the accessor guards say absent (never throws)", async () => {
    refreshAccessToken.mockResolvedValueOnce({
      data: { access_token: "new-access-token" },
      accessToken: () => "new-access-token",
      hasRefreshToken: () => false,
      refreshToken: () => {
        throw new Error("Missing or invalid 'refresh_token' field")
      },
      accessTokenExpiresInSeconds: () => {
        throw new Error("Missing or invalid 'expires_in' field")
      },
      hasScopes: () => false,
      scopes: () => {
        throw new Error("Missing or invalid 'scope' field")
      },
    })

    const result = await oauthRefreshFn({
      providerId: "github-app",
      refreshToken: "old-refresh-token",
      clientId: "cid",
      clientSecret: "csecret",
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tokens.accessToken).toBe("new-access-token")
      expect(result.tokens.refreshToken).toBeUndefined()
      expect(result.tokens.expiresInSeconds).toBeUndefined()
      expect(result.tokens.scopes).toBeUndefined()
    }
  })

  it("a thrown/absent accessToken() → reason unknown, never throws out of oauthRefreshFn", async () => {
    refreshAccessToken.mockResolvedValueOnce({
      data: {},
      accessToken: () => {
        throw new Error("Missing or invalid 'access_token' field")
      },
      hasRefreshToken: () => false,
      hasScopes: () => false,
    })

    const result = await oauthRefreshFn({
      providerId: "github-app",
      refreshToken: "old-refresh-token",
      clientId: "cid",
      clientSecret: "csecret",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })
})

describe("oauthRefreshFn — failure mapping", () => {
  it("OAuth2RequestError with code invalid_grant → reason invalid_grant", async () => {
    refreshAccessToken.mockRejectedValueOnce(
      new OAuth2RequestError("invalid_grant", "the refresh token has been revoked", null, null),
    )

    const result = await oauthRefreshFn({
      providerId: "github-app",
      refreshToken: SENTINEL_REFRESH_TOKEN,
      clientId: "cid",
      clientSecret: "csecret",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid_grant")
  })

  it("OAuth2RequestError with another code → reason unknown", async () => {
    refreshAccessToken.mockRejectedValueOnce(
      new OAuth2RequestError("invalid_client", "bad client credentials", null, null),
    )

    const result = await oauthRefreshFn({
      providerId: "github-app",
      refreshToken: SENTINEL_REFRESH_TOKEN,
      clientId: "cid",
      clientSecret: "csecret",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })

  it("ArcticFetchError (network) → reason transient", async () => {
    refreshAccessToken.mockRejectedValueOnce(new ArcticFetchError(new Error("ECONNREFUSED")))

    const result = await oauthRefreshFn({
      providerId: "github-app",
      refreshToken: SENTINEL_REFRESH_TOKEN,
      clientId: "cid",
      clientSecret: "csecret",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("transient")
  })

  it("an arbitrary thrown value → reason unknown, never propagates the throw", async () => {
    refreshAccessToken.mockRejectedValueOnce("a raw string throw")

    const result = await oauthRefreshFn({
      providerId: "github-app",
      refreshToken: SENTINEL_REFRESH_TOKEN,
      clientId: "cid",
      clientSecret: "csecret",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })
})

describe("oauthRefreshFn — no-token-leak (adversarial)", () => {
  it("a sentinel refresh token NEVER appears in the RefreshResult JSON on any failure path", async () => {
    const failures = [
      new OAuth2RequestError("invalid_grant", SENTINEL_REFRESH_TOKEN, null, null),
      new ArcticFetchError(new Error(SENTINEL_REFRESH_TOKEN)),
      new Error(SENTINEL_REFRESH_TOKEN),
    ]

    for (const failure of failures) {
      refreshAccessToken.mockRejectedValueOnce(failure)
      const result = await oauthRefreshFn({
        providerId: "github-app",
        refreshToken: SENTINEL_REFRESH_TOKEN,
        clientId: "cid",
        clientSecret: "csecret",
      })
      expect(JSON.stringify(result)).not.toContain(SENTINEL_REFRESH_TOKEN)
    }
  })

  it("unknown-provider / empty-provider paths never mention the sentinel token", async () => {
    const result = await oauthRefreshFn({
      providerId: "",
      refreshToken: SENTINEL_REFRESH_TOKEN,
      clientId: "cid",
      clientSecret: "csecret",
    })
    expect(JSON.stringify(result)).not.toContain(SENTINEL_REFRESH_TOKEN)
  })
})
