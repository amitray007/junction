// SPDX-License-Identifier: AGPL-3.0-only
// Provider catalog tests — pure data + pure dispatchers, no HTTP/I/O.

import { describe, expect, it } from "vitest"
import {
  buildAuthorizationParams,
  getProvider,
  listProviders,
  normalizeTokenResponse,
  resolveScopeString,
} from "./catalog.js"

describe("getProvider / listProviders", () => {
  it("getProvider returns undefined for an unknown id", () => {
    expect(getProvider("nope")).toBeUndefined()
  })

  it("listProviders includes all tuned providers + generic", () => {
    const ids = listProviders().map((p) => p.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "google",
        "github",
        "github-app",
        "slack",
        "microsoft",
        "notion",
        "atlassian",
        "discord",
        "spotify",
        "zoom",
        "dropbox",
        "linear",
        "gitlab",
        "figma",
        "generic",
      ]),
    )
  })
})

describe("inc-30 new providers (App catalog OAuth backing)", () => {
  it.each([
    "discord",
    "spotify",
    "zoom",
    "dropbox",
    "linear",
    "gitlab",
    "figma",
  ])("%s: PKCE S256, supports refresh, has authorize/token URLs", (id) => {
    const p = getProvider(id)
    expect(p).toBeDefined()
    if (!p) return
    expect(p.pkce).toBe("S256")
    expect(p.supportsRefresh).toBe(true)
    expect(typeof p.authorizationUrl).toBe("string")
    expect(p.authorizationUrl).not.toBe("")
    expect(typeof p.tokenUrl).toBe("string")
    expect(p.tokenUrl).not.toBe("")
  })

  it("dropbox: token endpoint is api.dropboxapi.com, not api.dropbox.com", () => {
    expect(getProvider("dropbox")?.tokenUrl).toBe("https://api.dropboxapi.com/oauth2/token")
  })

  it("figma: token endpoint is api.figma.com", () => {
    expect(getProvider("figma")?.tokenUrl).toBe("https://api.figma.com/v1/oauth/token")
  })

  it("linear: no userinfoUrl (identity is a GraphQL viewer query, not a bearer GET)", () => {
    expect(getProvider("linear")?.userinfoUrl).toBeUndefined()
  })
})

describe("tuned provider overrides", () => {
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

  it("microsoft: offline_access is a default scope (not an authorizationParams entry)", () => {
    const p = getProvider("microsoft")
    expect(p).toBeDefined()
    if (!p) return
    expect(p.defaultScopes).toContain("offline_access")
    expect(p.deviceAuthorizationUrl).toBeDefined()
  })

  it("notion: basic token auth, tokens never expire", () => {
    const p = getProvider("notion")
    expect(p).toBeDefined()
    if (!p) return
    expect(p.tokenAuthMethod).toBe("client_secret_basic")
    expect(p.expiryStrategy).toBe("none")
    expect(p.supportsRefresh).toBe(false)
  })

  it("atlassian: audience + consent authorizationParams", () => {
    const p = getProvider("atlassian")
    expect(p).toBeDefined()
    if (!p) return
    expect(p.authorizationParams).toEqual({ audience: "api.atlassian.com", prompt: "consent" })
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
    const slack = getProvider("slack")
    const google = getProvider("google")
    expect(slack).toBeDefined()
    expect(google).toBeDefined()
    if (!slack || !google) return
    expect(resolveScopeString(slack, ["a", "b"])).toBe("a,b")
    expect(resolveScopeString(google, ["a", "b"])).toBe("a b")
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

  it("prepends provider defaultScopes (e.g. microsoft's offline_access)", () => {
    const ms = getProvider("microsoft")
    expect(ms).toBeDefined()
    if (!ms) return
    const params = buildAuthorizationParams(ms, ["User.Read"])
    expect(params.scope).toBe("offline_access User.Read")
  })

  it("dedupes a scope that is ALSO one of the provider's defaultScopes (e.g. explicitly requesting microsoft's offline_access)", () => {
    const ms = getProvider("microsoft")
    expect(ms).toBeDefined()
    if (!ms) return
    // Caller explicitly asks for "offline_access" too — already a defaultScope.
    const params = buildAuthorizationParams(ms, ["offline_access", "User.Read"])
    expect(params.scope).toBe("offline_access User.Read")
    expect(params.scope?.split(" ").filter((s) => s === "offline_access")).toHaveLength(1)
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
    expect(getProvider("google")?.userinfoUrl).toBe("https://www.googleapis.com/oauth2/v3/userinfo")
    expect(getProvider("github")?.userinfoUrl).toBe("https://api.github.com/user")
    expect(getProvider("github-app")?.userinfoUrl).toBe("https://api.github.com/user")
    expect(getProvider("slack")?.userinfoUrl).toBe("https://slack.com/api/auth.test")
    expect(getProvider("microsoft")?.userinfoUrl).toBe("https://graph.microsoft.com/v1.0/me")
    expect(getProvider("notion")?.userinfoUrl).toBe("https://api.notion.com/v1/users/me")
  })

  it("github requires a User-Agent header (GitHub rejects UA-less requests)", () => {
    expect(getProvider("github")?.userinfoHeaders?.["User-Agent"]).toBeDefined()
  })

  it("notion requires the Notion-Version header", () => {
    expect(getProvider("notion")?.userinfoHeaders?.["Notion-Version"]).toBeDefined()
  })

  it("atlassian + generic have NO userinfoUrl (needs a scope junction can't guarantee / user-supplied)", () => {
    expect(getProvider("atlassian")?.userinfoUrl).toBeUndefined()
    expect(getProvider("generic")?.userinfoUrl).toBeUndefined()
  })

  it("userinfoHeaders never contains an Authorization header (the bearer is added by the verifier)", () => {
    for (const p of listProviders()) {
      const keys = Object.keys(p.userinfoHeaders ?? {}).map((k) => k.toLowerCase())
      expect(keys).not.toContain("authorization")
    }
  })
})
