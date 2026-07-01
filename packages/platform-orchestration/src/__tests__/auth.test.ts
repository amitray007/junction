// SPDX-License-Identifier: AGPL-3.0-only
// Exhaustive coverage for the shared auth helpers extracted from cli/commands/platform.ts.
// These were provider-selection logic in the CLI with no direct coverage; the openapi/graphql
// add tests only exercise an explicit-override or no-scheme path, so buildPlatformAuth's
// error arms and deriveAuthFromSpec's securityScheme branches were untested until here.
import { describe, expect, it } from "vitest"
import { buildPlatformAuth, deriveAuthFromSpec } from "../auth.js"

describe("buildPlatformAuth", () => {
  it("returns undefined when no scheme is given (caller applies a fallback)", () => {
    const r = buildPlatformAuth({})
    expect(r.isOk()).toBe(true)
    if (r.isOk()) expect(r.value).toBeUndefined()
  })

  it("bearer → Authorization header", () => {
    const r = buildPlatformAuth({ scheme: "bearer" })
    expect(r.isOk()).toBe(true)
    if (r.isOk()) expect(r.value).toEqual({ scheme: "bearer", header: "Authorization" })
  })

  it("apiKey defaults to `in: header` when in is omitted", () => {
    const r = buildPlatformAuth({ scheme: "apiKey", name: "X-API-Key" })
    expect(r.isOk()).toBe(true)
    if (r.isOk()) expect(r.value).toEqual({ scheme: "apiKey", in: "header", name: "X-API-Key" })
  })

  it("apiKey honors an explicit in (query, cookie)", () => {
    const q = buildPlatformAuth({ scheme: "apiKey", in: "query", name: "api_key" })
    expect(q.isOk()).toBe(true)
    if (q.isOk()) expect(q.value).toEqual({ scheme: "apiKey", in: "query", name: "api_key" })
    const c = buildPlatformAuth({ scheme: "apiKey", in: "cookie", name: "sid" })
    expect(c.isOk()).toBe(true)
    if (c.isOk()) expect(c.value).toEqual({ scheme: "apiKey", in: "cookie", name: "sid" })
  })

  it("apiKey without a name → missing-field", () => {
    const r = buildPlatformAuth({ scheme: "apiKey" })
    expect(r.isErr()).toBe(true)
    if (r.isErr())
      expect(r.error).toEqual({
        kind: "missing-field",
        field: "auth-name",
        context: "apiKey auth scheme",
      })
  })

  it("basic with a username → basic auth", () => {
    const r = buildPlatformAuth({ scheme: "basic", username: "svc" })
    expect(r.isOk()).toBe(true)
    if (r.isOk()) expect(r.value).toEqual({ scheme: "basic", username: "svc" })
  })

  it("basic without a username → missing-field", () => {
    const r = buildPlatformAuth({ scheme: "basic" })
    expect(r.isErr()).toBe(true)
    if (r.isErr())
      expect(r.error).toEqual({
        kind: "missing-field",
        field: "auth-username",
        context: "basic auth scheme",
      })
  })

  it("an unknown scheme → invalid-connection with the naming message", () => {
    // Cast through unknown: the type forbids it, but a hand-built descriptor could carry it.
    const r = buildPlatformAuth({ scheme: "oauth2" as unknown as "bearer" })
    expect(r.isErr()).toBe(true)
    if (r.isErr()) {
      expect(r.error.kind).toBe("invalid-connection")
      if (r.error.kind === "invalid-connection")
        expect(r.error.message).toContain("Unknown auth scheme")
    }
  })
})

describe("deriveAuthFromSpec", () => {
  it("no components → undefined", () => {
    expect(deriveAuthFromSpec({})).toBeUndefined()
    expect(deriveAuthFromSpec({ components: null })).toBeUndefined()
  })

  it("components without securitySchemes → undefined", () => {
    expect(deriveAuthFromSpec({ components: {} })).toBeUndefined()
  })

  it("derives an apiKey scheme (header) from securitySchemes", () => {
    const auth = deriveAuthFromSpec({
      components: {
        securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "X-Key" } },
      },
    })
    expect(auth).toEqual({ scheme: "apiKey", in: "header", name: "X-Key" })
  })

  it("derives an apiKey scheme in query", () => {
    const auth = deriveAuthFromSpec({
      components: { securitySchemes: { Q: { type: "apiKey", in: "query", name: "api_key" } } },
    })
    expect(auth).toEqual({ scheme: "apiKey", in: "query", name: "api_key" })
  })

  it("derives http bearer → Authorization header", () => {
    const auth = deriveAuthFromSpec({
      components: { securitySchemes: { Bearer: { type: "http", scheme: "bearer" } } },
    })
    expect(auth).toEqual({ scheme: "bearer", header: "Authorization" })
  })

  it("http basic → undefined (username can't be derived from the spec)", () => {
    const auth = deriveAuthFromSpec({
      components: { securitySchemes: { Basic: { type: "http", scheme: "basic" } } },
    })
    expect(auth).toBeUndefined()
  })

  it("oauth2 → { scheme: oauth2 }", () => {
    const auth = deriveAuthFromSpec({
      components: { securitySchemes: { OAuth: { type: "oauth2", flows: {} } } },
    })
    expect(auth).toEqual({ scheme: "oauth2" })
  })

  it("skips malformed scheme entries and falls through to undefined", () => {
    const auth = deriveAuthFromSpec({
      components: { securitySchemes: { Bad: null, AlsoBad: { type: "apiKey" /* no name/in */ } } },
    })
    expect(auth).toBeUndefined()
  })

  it("returns the FIRST usable scheme when several are present", () => {
    // apiKey listed first → wins over the later bearer.
    const auth = deriveAuthFromSpec({
      components: {
        securitySchemes: {
          Key: { type: "apiKey", in: "header", name: "X-Key" },
          Bearer: { type: "http", scheme: "bearer" },
        },
      },
    })
    expect(auth).toEqual({ scheme: "apiKey", in: "header", name: "X-Key" })
  })
})
