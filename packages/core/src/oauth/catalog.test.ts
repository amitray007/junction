// SPDX-License-Identifier: AGPL-3.0-only
// Provider catalog tests — pure data + pure dispatchers, no HTTP/I/O. Reduced
// to github/github-app/generic in increment 35 (catalog strip-down); slack was
// reintroduced in increment 37, google in increment 39, each alongside its
// app catalog entry.

import { describe, expect, it } from "vitest"
import {
  buildAuthorizationParams,
  getProvider,
  listProviders,
  normalizeTokenResponse,
  type OAuthProvider,
  resolveScopeString,
} from "./catalog.js"

describe("getProvider / listProviders", () => {
  it("getProvider returns undefined for an unknown id", () => {
    expect(getProvider("nope")).toBeUndefined()
  })

  it("listProviders returns exactly github/github-app/slack/google/generic", () => {
    const ids = listProviders().map((p) => p.id)
    expect(ids).toEqual(["github", "github-app", "slack", "google", "generic"])
  })
})

describe("tuned provider overrides", () => {
  it("github (OAuth App): no refresh, tokens never expire", () => {
    const p = getProvider("github")
    expect(p).toBeDefined()
    if (!p) return
    expect(p.supportsRefresh).toBe(false)
    expect(p.expiryStrategy).toBe("none")
  })

  it("github-app: rotates, has an expiry", () => {
    const p = getProvider("github-app")
    expect(p).toBeDefined()
    if (!p) return
    expect(p.supportsRefresh).toBe(true)
    expect(p.expiryStrategy).toBe("expires_in")
  })

  it("google: authorizationParams requests offline access + consent, ephemeral redirect, device-code", () => {
    const p = getProvider("google")
    expect(p).toBeDefined()
    if (!p) return
    expect(p.authorizationParams).toEqual({ access_type: "offline", prompt: "consent" })
    expect(p.redirectMode).toBe("loopback-ephemeral")
    expect(p.deviceAuthorizationUrl).toBeDefined()
    expect(p.supportsRefresh).toBe(true)
    expect(p.expiryStrategy).toBe("expires_in")
  })

  it("generic: sensible defaults, empty placeholder endpoints", () => {
    const p = getProvider("generic")
    expect(p).toBeDefined()
    if (!p) return
    expect(p.pkce).toBe("S256")
    expect(p.scopeSeparator).toBe(" ")
    expect(p.expiryStrategy).toBe("expires_in")
    expect(p.redirectMode).toBe("loopback-fixed")
    expect(p.supportsRefresh).toBe(true)
    expect(p.authorizationUrl).toBe("")
    expect(p.tokenUrl).toBe("")
  })
})

describe("catalog grep-clean (increment 44)", () => {
  it("no provider carries the removed tokenAuthMethod/bodyFormat fields", () => {
    for (const p of listProviders()) {
      expect((p as Record<string, unknown>).tokenAuthMethod).toBeUndefined()
      expect((p as Record<string, unknown>).bodyFormat).toBeUndefined()
    }
  })

  it("authorizationUrl/tokenUrl are plain strings, never the removed fn form", () => {
    for (const p of listProviders()) {
      expect(typeof p.authorizationUrl).toBe("string")
      expect(typeof p.tokenUrl).toBe("string")
    }
  })

  it("pkce accepts 'plain' (widened alongside S256/disabled)", () => {
    const plainProvider: OAuthProvider = {
      id: "synthetic-plain-pkce",
      displayName: "Synthetic Plain PKCE",
      authorizationUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      pkce: "plain",
      scopeSeparator: " ",
      expiryStrategy: "expires_in",
      redirectMode: "loopback-fixed",
      supportsRefresh: true,
      registrationHint: { redirectUri: "", scopes: "", docsUrl: "" },
    }
    expect(plainProvider.pkce).toBe("plain")
  })
})

describe("resolveScopeString", () => {
  it("uses the provider's separator", () => {
    const slack = getProvider("slack")
    const google = getProvider("google")
    const github = getProvider("github")
    expect(slack).toBeDefined()
    expect(google).toBeDefined()
    expect(github).toBeDefined()
    if (!slack || !google || !github) return
    expect(resolveScopeString(slack, ["a", "b"])).toBe("a,b")
    expect(resolveScopeString(google, ["a", "b"])).toBe("a b")
    expect(resolveScopeString(github, ["a", "b"])).toBe("a b")
  })
})

describe("buildAuthorizationParams", () => {
  it("merges catalog authorizationParams with the assembled scope string", () => {
    const google = getProvider("google")
    expect(google).toBeDefined()
    if (!google) return
    const params = buildAuthorizationParams(google, ["a", "b"])
    expect(params).toEqual({ access_type: "offline", prompt: "consent", scope: "a b" })
  })

  it("prepends provider defaultScopes and dedupes a scope that is ALSO a defaultScope", () => {
    // No surviving catalog provider carries defaultScopes (microsoft removed
    // in inc 35) — assert the dedupe mechanism directly against a synthetic
    // provider rather than lose this coverage entirely.
    const providerWithDefaultScopes: OAuthProvider = {
      id: "synthetic-default-scopes",
      displayName: "Synthetic",
      authorizationUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      pkce: "S256",
      scopeSeparator: " ",
      expiryStrategy: "expires_in",
      redirectMode: "loopback-fixed",
      defaultScopes: ["offline_access"],
      supportsRefresh: true,
      registrationHint: { redirectUri: "", scopes: "", docsUrl: "" },
    }

    const params = buildAuthorizationParams(providerWithDefaultScopes, ["User.Read"])
    expect(params.scope).toBe("offline_access User.Read")

    // Caller explicitly asks for "offline_access" too — already a defaultScope.
    const deduped = buildAuthorizationParams(providerWithDefaultScopes, [
      "offline_access",
      "User.Read",
    ])
    expect(deduped.scope).toBe("offline_access User.Read")
    expect(deduped.scope?.split(" ").filter((s) => s === "offline_access")).toHaveLength(1)
  })
})

describe("normalizeTokenResponse", () => {
  it("slack rejects {ok:false} at HTTP 200 (throws)", () => {
    const slack = getProvider("slack")
    expect(slack).toBeDefined()
    if (!slack) return
    expect(() => normalizeTokenResponse(slack, { ok: false, error: "invalid_code" })).toThrow(
      /slack: invalid_code/,
    )
  })

  it("slack happily parses a {ok:true, access_token, ...} response", () => {
    const slack = getProvider("slack")
    expect(slack).toBeDefined()
    if (!slack) return
    const tokens = normalizeTokenResponse(slack, {
      ok: true,
      access_token: "xoxb-123",
      scope: "channels:read,chat:write",
    })
    expect(tokens.accessToken).toBe("xoxb-123")
    expect(tokens.scopes).toEqual(["channels:read", "chat:write"])
  })

  it("slack falls back to authed_user.access_token when the top-level token is absent", () => {
    const slack = getProvider("slack")
    expect(slack).toBeDefined()
    if (!slack) return
    const tokens = normalizeTokenResponse(slack, {
      ok: true,
      authed_user: { access_token: "xoxp-456" },
    })
    expect(tokens.accessToken).toBe("xoxp-456")
  })

  it("default parser: standard OAuth2 response normalizes scopes by the provider's separator", () => {
    const github = getProvider("github")
    expect(github).toBeDefined()
    if (!github) return
    const tokens = normalizeTokenResponse(github, {
      access_token: "gho_abc",
      refresh_token: "ghr_def",
      expires_in: 3600,
      scope: "a b",
    })
    expect(tokens).toEqual({
      accessToken: "gho_abc",
      refreshToken: "ghr_def",
      expiresInSeconds: 3600,
      scopes: ["a", "b"],
    })
  })

  it("default parser: a response with NO refresh_token leaves refreshToken undefined (keep-old semantics)", () => {
    const github = getProvider("github")
    expect(github).toBeDefined()
    if (!github) return
    const tokens = normalizeTokenResponse(github, { access_token: "gho_abc" })
    expect(tokens.refreshToken).toBeUndefined()
  })

  it("default parser throws when access_token is missing", () => {
    const github = getProvider("github")
    expect(github).toBeDefined()
    if (!github) return
    expect(() => normalizeTokenResponse(github, {})).toThrow()
  })
})

describe("userinfoUrl (OAuth-native Test Connection)", () => {
  it("tuned providers with a stable identity endpoint carry a userinfoUrl", () => {
    expect(getProvider("github")?.userinfoUrl).toBe("https://api.github.com/user")
    expect(getProvider("github-app")?.userinfoUrl).toBe("https://api.github.com/user")
    expect(getProvider("slack")?.userinfoUrl).toBe("https://slack.com/api/auth.test")
    expect(getProvider("google")?.userinfoUrl).toBe("https://www.googleapis.com/oauth2/v3/userinfo")
  })

  it("github requires a User-Agent header (GitHub rejects UA-less requests)", () => {
    expect(getProvider("github")?.userinfoHeaders?.["User-Agent"]).toBeDefined()
  })

  it("generic has NO userinfoUrl (user-supplied — no stable endpoint junction can assume)", () => {
    expect(getProvider("generic")?.userinfoUrl).toBeUndefined()
  })

  it("userinfoHeaders never contains an Authorization header (the bearer is added by the verifier)", () => {
    for (const p of listProviders()) {
      const keys = Object.keys(p.userinfoHeaders ?? {}).map((k) => k.toLowerCase())
      expect(keys).not.toContain("authorization")
    }
  })
})
