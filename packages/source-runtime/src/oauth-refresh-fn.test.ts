// SPDX-License-Identifier: AGPL-3.0-only
// oauthRefreshFn tests — the arctic-backed RefreshTokenFn (increment 29,
// slice B). Mocks arctic's OAuth2Client (no real HTTP) and asserts:
//   - empty/unknown providerId hard-fails to reason "unknown", never throws.
//   - a successful refresh normalizes guarded accessor reads correctly.
//   - invalid_grant / transient / unknown failures map correctly.
//   - a sentinel refresh token NEVER appears in any returned `detail` (the
//     no-leak adversarial proof).

import { getProvider, type OAuthProvider } from "@junction/core"
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

// Increment 45: oauthRefreshFn now receives the ALREADY-RESOLVED design (the
// orchestrator resolved it against the merged built-in + custom set) rather
// than re-looking it up built-ins-only — this is what makes custom-design
// refresh work. A minimal built-in-shaped design fixture; a CUSTOM design has
// the identical shape (only its id differs), so these tests cover both.
const DESIGN = getProvider("github-app") as OAuthProvider
// A design whose tokenUrl is empty (the only "unresolvable" case now that the
// provider is passed in, not looked up) — mirrors the "generic" placeholder.
const EMPTY_TOKEN_URL_DESIGN: OAuthProvider = { ...DESIGN, id: "custom:empty", tokenUrl: "" }

/** Base args with a valid resolved design; override per test. */
function baseArgs(overrides: Partial<Parameters<typeof oauthRefreshFn>[0]> = {}) {
  return {
    providerId: DESIGN.id,
    design: DESIGN,
    refreshToken: SENTINEL_REFRESH_TOKEN,
    clientId: "cid",
    clientSecret: "csecret",
    ...overrides,
  }
}

describe("oauthRefreshFn — hard-fail on empty providerId / unresolvable tokenUrl", () => {
  it("empty providerId → reason unknown, never throws", async () => {
    const result = await oauthRefreshFn(baseArgs({ providerId: "" }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })

  it("whitespace-only providerId → reason unknown", async () => {
    const result = await oauthRefreshFn(baseArgs({ providerId: "   " }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })

  it("a design with an empty tokenUrl → reason unknown (unresolvable), never throws", async () => {
    // Post-inc-45 the provider is PASSED IN (not looked up), so the "unknown
    // provider" failure mode is now "the resolved design has no usable tokenUrl"
    // — e.g. the generic placeholder before a connect descriptor fills it.
    const result = await oauthRefreshFn(
      baseArgs({ providerId: EMPTY_TOKEN_URL_DESIGN.id, design: EMPTY_TOKEN_URL_DESIGN }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })

  it("a CUSTOM design refreshes through its own tokenUrl (not a built-ins lookup)", async () => {
    // The regression this whole change fixes: a custom:<slug> design must be
    // able to refresh. It reaches arctic's refreshAccessToken with the custom
    // design's tokenUrl — getProvider(custom:*) would have returned undefined.
    refreshAccessToken.mockResolvedValueOnce({
      data: { access_token: "custom-access" },
      accessToken: () => "custom-access",
      hasRefreshToken: () => false,
      hasScopes: () => false,
    })
    const customDesign: OAuthProvider = {
      ...DESIGN,
      id: "custom:acme",
      tokenUrl: "https://acme.example.com/oauth/token",
    }
    const result = await oauthRefreshFn(
      baseArgs({ providerId: customDesign.id, design: customDesign }),
    )
    expect(result.ok).toBe(true)
    // arctic was called with the CUSTOM design's tokenUrl.
    expect(refreshAccessToken).toHaveBeenCalledWith(
      "https://acme.example.com/oauth/token",
      expect.anything(),
      expect.anything(),
    )
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

    const result = await oauthRefreshFn(baseArgs({ refreshToken: "old-refresh-token" }))

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

    const result = await oauthRefreshFn(baseArgs({ refreshToken: "old-refresh-token" }))

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

    const result = await oauthRefreshFn(baseArgs({ refreshToken: "old-refresh-token" }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })
})

describe("oauthRefreshFn — failure mapping", () => {
  it("OAuth2RequestError with code invalid_grant → reason invalid_grant", async () => {
    refreshAccessToken.mockRejectedValueOnce(
      new OAuth2RequestError("invalid_grant", "the refresh token has been revoked", null, null),
    )

    const result = await oauthRefreshFn(baseArgs())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid_grant")
  })

  it("OAuth2RequestError with another code → reason unknown", async () => {
    refreshAccessToken.mockRejectedValueOnce(
      new OAuth2RequestError("invalid_client", "bad client credentials", null, null),
    )

    const result = await oauthRefreshFn(baseArgs())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })

  it("ArcticFetchError (network) → reason transient", async () => {
    refreshAccessToken.mockRejectedValueOnce(new ArcticFetchError(new Error("ECONNREFUSED")))

    const result = await oauthRefreshFn(baseArgs())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("transient")
  })

  it("an arbitrary thrown value → reason unknown, never propagates the throw", async () => {
    refreshAccessToken.mockRejectedValueOnce("a raw string throw")

    const result = await oauthRefreshFn(baseArgs())

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
      const result = await oauthRefreshFn(baseArgs())
      expect(JSON.stringify(result)).not.toContain(SENTINEL_REFRESH_TOKEN)
    }
  })

  it("unknown-provider / empty-provider paths never mention the sentinel token", async () => {
    const result = await oauthRefreshFn(baseArgs({ providerId: "" }))
    expect(JSON.stringify(result)).not.toContain(SENTINEL_REFRESH_TOKEN)
  })
})
