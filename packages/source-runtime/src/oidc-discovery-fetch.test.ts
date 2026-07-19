// SPDX-License-Identifier: AGPL-3.0-only
// fetchOidcDiscovery tests — mock global fetch (mirrors verify-credential's
// oauth2 identity-check tests: no real network, no touching core's
// discoveredDesignFromDoc's correctness beyond confirming it's wired in).

import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchOidcDiscovery } from "./oidc-discovery-fetch.js"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function validWellKnownBody() {
  return JSON.stringify({
    issuer: "https://acme.example.com",
    authorization_endpoint: "https://acme.example.com/oauth/authorize",
    token_endpoint: "https://acme.example.com/oauth/token",
    userinfo_endpoint: "https://acme.example.com/oauth/userinfo",
    scopes_supported: ["openid", "profile"],
    code_challenge_methods_supported: ["S256"],
  })
}

describe("fetchOidcDiscovery — success", () => {
  it("a 200 well-known doc → filled partial design", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(validWellKnownBody(), { status: 200 }))
    const result = await fetchOidcDiscovery("https://acme.example.com")
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual({
        authorizationUrl: "https://acme.example.com/oauth/authorize",
        tokenUrl: "https://acme.example.com/oauth/token",
        userinfoUrl: "https://acme.example.com/oauth/userinfo",
        defaultScopes: ["openid", "profile"],
        pkce: "S256",
      })
    }
  })

  it("sends a plain unauthenticated GET (no Authorization header, no body)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(validWellKnownBody(), { status: 200 }))
    globalThis.fetch = fetchSpy
    await fetchOidcDiscovery("https://acme.example.com")
    const call = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(call[1].method).toBe("GET")
    const headers = call[1].headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(call[1].body).toBeUndefined()
  })
})

describe("fetchOidcDiscovery — issuer URL normalization (trailing slash)", () => {
  it("issuer URL WITHOUT trailing slash resolves to <issuer>/.well-known/openid-configuration", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(validWellKnownBody(), { status: 200 }))
    globalThis.fetch = fetchSpy
    await fetchOidcDiscovery("https://acme.example.com")
    const call = fetchSpy.mock.calls[0] as [string]
    expect(call[0]).toBe("https://acme.example.com/.well-known/openid-configuration")
  })

  it("issuer URL WITH trailing slash resolves to the SAME well-known URL (no double slash)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(validWellKnownBody(), { status: 200 }))
    globalThis.fetch = fetchSpy
    await fetchOidcDiscovery("https://acme.example.com/")
    const call = fetchSpy.mock.calls[0] as [string]
    expect(call[0]).toBe("https://acme.example.com/.well-known/openid-configuration")
  })
})

describe("fetchOidcDiscovery — HTTP failures", () => {
  it("a 404 → typed non-2xx error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }))
    const result = await fetchOidcDiscovery("https://acme.example.com")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error).toEqual({ kind: "non-2xx", status: 404 })
  })

  it("a 500 → typed non-2xx error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }))
    const result = await fetchOidcDiscovery("https://acme.example.com")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error).toEqual({ kind: "non-2xx", status: 500 })
  })

  it("malformed JSON body (200 but not valid JSON) → typed malformed-json error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{ not valid json", { status: 200 }))
    const result = await fetchOidcDiscovery("https://acme.example.com")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error).toEqual({ kind: "malformed-json" })
  })

  it("a non-conforming doc (valid JSON, missing required fields) → typed non-conforming-doc error, cause is core's typed error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ issuer: "x" }), { status: 200 }))
    const result = await fetchOidcDiscovery("https://acme.example.com")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("non-conforming-doc")
      if (result.error.kind === "non-conforming-doc") {
        expect(result.error.cause.kind).toBe("non-conforming-doc")
      }
    }
  })

  it("network error (fetch rejects) → typed unreachable error with a leak-safe constructor-name detail", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed to https://secret-internal-host"))
    const result = await fetchOidcDiscovery("https://acme.example.com")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({ kind: "unreachable", detail: "TypeError" })
      expect(JSON.stringify(result.error)).not.toContain("secret-internal-host")
    }
  })

  it("timeout (AbortError) → typed unreachable error, never hangs", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), {
        name: "AbortError",
        constructor: { name: "DOMException" },
      }),
    )
    const result = await fetchOidcDiscovery("https://acme.example.com")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("unreachable")
  })

  it("never throws across the boundary — every failure resolves as a typed Err", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("anything"))
    await expect(fetchOidcDiscovery("https://acme.example.com")).resolves.toBeDefined()
  })
})
