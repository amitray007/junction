// SPDX-License-Identifier: AGPL-3.0-only
// Provider catalog tests — pure data + pure dispatchers, no HTTP/I/O. Reduced
// to github/github-app/generic in increment 35 (catalog strip-down) — the
// other providers are reintroduced properly, alongside their app, starting
// increment 36.

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

  it("listProviders returns exactly github/github-app/generic (inc 35 strip-down)", () => {
    const ids = listProviders().map((p) => p.id)
    expect(ids).toEqual(["github", "github-app", "generic"])
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

  it("generic: sensible defaults, empty placeholder endpoints", () => {
    const p = getProvider("generic")
    expect(p).toBeDefined()
    if (!p) return
    expect(p.pkce).toBe("S256")
    expect(p.scopeSeparator).toBe(" ")
    expect(p.tokenAuthMethod).toBe("client_secret_basic")
    expect(p.bodyFormat).toBe("form")
    expect(p.expiryStrategy).toBe("expires_in")
    expect(p.redirectMode).toBe("loopback-fixed")
    expect(p.supportsRefresh).toBe(true)
    expect(p.authorizationUrl).toBe("")
    expect(p.tokenUrl).toBe("")
  })
})

describe("resolveScopeString", () => {
  it("uses the provider's separator", () => {
    const github = getProvider("github")
    const generic = getProvider("generic")
    expect(github).toBeDefined()
    expect(generic).toBeDefined()
    if (!github || !generic) return
    expect(resolveScopeString(github, ["a", "b"])).toBe("a b")
    expect(resolveScopeString(generic, ["a", "b"])).toBe("a b")
  })

  it("uses a provider's non-default separator when it has one (comma)", () => {
    // No surviving catalog provider uses a comma separator (removed with
    // slack in inc 35) — assert the mechanism directly against a synthetic
    // provider rather than lose separator coverage entirely.
    const commaProvider: OAuthProvider = {
      id: "synthetic-comma",
      displayName: "Synthetic",
      authorizationUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      pkce: "S256",
      scopeSeparator: ",",
      tokenAuthMethod: "client_secret_post",
      bodyFormat: "form",
      expiryStrategy: "expires_in",
      redirectMode: "loopback-fixed",
      supportsRefresh: true,
      registrationHint: { redirectUri: "", scopes: "", docsUrl: "" },
    }
    expect(resolveScopeString(commaProvider, ["a", "b"])).toBe("a,b")
  })
})

describe("buildAuthorizationParams", () => {
  it("merges catalog authorizationParams with the assembled scope string", () => {
    const github = getProvider("github")
    expect(github).toBeDefined()
    if (!github) return
    const params = buildAuthorizationParams(github, ["a", "b"])
    expect(params).toEqual({ scope: "a b" })
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
      tokenAuthMethod: "client_secret_post",
      bodyFormat: "form",
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
