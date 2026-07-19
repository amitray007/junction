// SPDX-License-Identifier: AGPL-3.0-only
// oidc-discovery tests — pure parse/shape only (no fetch; that's
// source-runtime's oidc-discovery-fetch.test.ts). Covers: a valid well-known
// doc maps to a filled partial design; a doc missing a required endpoint is a
// typed error; unknown extra fields are tolerated (Zod strips); scopes_supported
// maps to defaultScopes; code_challenge_methods_supported doesn't change the
// PKCE outcome (see the module's DEFAULT_DISCOVERED_PKCE note).

import { describe, expect, it } from "vitest"
import { discoveredDesignFromDoc } from "./oidc-discovery.js"

const BASE_DOC = {
  issuer: "https://acme.example.com",
  authorization_endpoint: "https://acme.example.com/oauth/authorize",
  token_endpoint: "https://acme.example.com/oauth/token",
  userinfo_endpoint: "https://acme.example.com/oauth/userinfo",
  scopes_supported: ["openid", "profile", "email"],
  code_challenge_methods_supported: ["S256"],
} satisfies Record<string, unknown>

function validDoc(overrides: Record<string, unknown> = {}) {
  return { ...BASE_DOC, ...overrides }
}

/** Build a doc from BASE_DOC with the given keys OMITTED (never via `delete`). */
function docWithout(...keys: (keyof typeof BASE_DOC)[]) {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(BASE_DOC)) {
    if (!keys.includes(key as keyof typeof BASE_DOC)) result[key] = value
  }
  return result
}

describe("discoveredDesignFromDoc", () => {
  it("a valid well-known doc maps to a filled partial design (endpoints mapped, pkce S256)", () => {
    const result = discoveredDesignFromDoc("https://acme.example.com", validDoc())
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual({
        authorizationUrl: "https://acme.example.com/oauth/authorize",
        tokenUrl: "https://acme.example.com/oauth/token",
        userinfoUrl: "https://acme.example.com/oauth/userinfo",
        defaultScopes: ["openid", "profile", "email"],
        pkce: "S256",
      })
    }
  })

  it("does NOT set id or displayName — discovery fills endpoints, not identity", () => {
    const result = discoveredDesignFromDoc("https://acme.example.com", validDoc())
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).not.toHaveProperty("id")
      expect(result.value).not.toHaveProperty("displayName")
    }
  })

  it("a doc missing token_endpoint → typed non-conforming-doc error", () => {
    const result = discoveredDesignFromDoc("https://acme.example.com", docWithout("token_endpoint"))
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("non-conforming-doc")
  })

  it("a doc missing authorization_endpoint → typed non-conforming-doc error", () => {
    const result = discoveredDesignFromDoc(
      "https://acme.example.com",
      docWithout("authorization_endpoint"),
    )
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("non-conforming-doc")
  })

  it("a doc missing issuer → typed non-conforming-doc error", () => {
    const result = discoveredDesignFromDoc("https://acme.example.com", docWithout("issuer"))
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("non-conforming-doc")
  })

  it("a malformed endpoint URL (not a valid URL string) → typed error", () => {
    const doc = validDoc({ token_endpoint: "not-a-url" })
    const result = discoveredDesignFromDoc("https://acme.example.com", doc)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("non-conforming-doc")
  })

  it("a doc with extra unknown fields still parses (Zod strips unknown keys)", () => {
    const doc = validDoc({
      registration_endpoint: "https://acme.example.com/oauth/register",
      response_types_supported: ["code"],
      some_future_field: { nested: true },
    })
    const result = discoveredDesignFromDoc("https://acme.example.com", doc)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).not.toHaveProperty("registration_endpoint")
      expect(result.value).not.toHaveProperty("response_types_supported")
    }
  })

  it("scopes_supported maps to defaultScopes", () => {
    const doc = validDoc({ scopes_supported: ["a", "b", "c"] })
    const result = discoveredDesignFromDoc("https://acme.example.com", doc)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.defaultScopes).toEqual(["a", "b", "c"])
  })

  it("scopes_supported absent → defaultScopes absent (not set to an empty array)", () => {
    const result = discoveredDesignFromDoc(
      "https://acme.example.com",
      docWithout("scopes_supported"),
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).not.toHaveProperty("defaultScopes")
  })

  it("userinfo_endpoint absent → userinfoUrl absent", () => {
    const result = discoveredDesignFromDoc(
      "https://acme.example.com",
      docWithout("userinfo_endpoint"),
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).not.toHaveProperty("userinfoUrl")
  })

  it("code_challenge_methods_supported WITHOUT S256 still yields pkce S256 (the safe default)", () => {
    const doc = validDoc({ code_challenge_methods_supported: ["plain"] })
    const result = discoveredDesignFromDoc("https://acme.example.com", doc)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.pkce).toBe("S256")
  })

  it("code_challenge_methods_supported absent entirely still yields pkce S256", () => {
    const result = discoveredDesignFromDoc(
      "https://acme.example.com",
      docWithout("code_challenge_methods_supported"),
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.pkce).toBe("S256")
  })

  it("a completely non-conforming doc (wrong shape entirely) → typed error, never throws", () => {
    expect(() => discoveredDesignFromDoc("https://acme.example.com", { foo: "bar" })).not.toThrow()
    const result = discoveredDesignFromDoc("https://acme.example.com", { foo: "bar" })
    expect(result.isErr()).toBe(true)
  })

  it("null / non-object raw doc → typed error, never throws", () => {
    expect(() => discoveredDesignFromDoc("https://acme.example.com", null)).not.toThrow()
    const result = discoveredDesignFromDoc("https://acme.example.com", null)
    expect(result.isErr()).toBe(true)
  })
})
