// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for oauth-design-mutations.server.ts (increment 45, Slice D2).
// discoverOidc is mocked at the @junction/source-runtime boundary — the real
// fetch/discovery-shape logic already has a dedicated suite
// (source-runtime/src/oidc-discovery-fetch.test.ts); this file only proves
// THIS module's own wrapping (result → {ok,...} shape, error-message mapping)
// and mutateAddCustomDesign/mutateDeleteCustomDesign against a real temp home
// + real DB (the referrer-naming path is worth exercising for real, not mocked).

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRepositories, getDatabase, getPaths, newPlatformId } from "@junction/core"
import { errAsync, okAsync } from "neverthrow"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fetchOidcDiscoveryMock = vi.fn()

vi.mock("@junction/source-runtime", () => ({
  fetchOidcDiscovery: (...args: unknown[]) => fetchOidcDiscoveryMock(...args),
}))

const { assertTokenUrlConfirmed, discoverOidc, mutateAddCustomDesign, mutateDeleteCustomDesign } =
  await import("./oauth-design-mutations.server.js")

describe("discoverOidc", () => {
  afterEach(() => {
    fetchOidcDiscoveryMock.mockReset()
  })

  it("a successful discovery returns {ok:true, design: <partial>}", async () => {
    fetchOidcDiscoveryMock.mockReturnValue(
      okAsync({
        authorizationUrl: "https://issuer.example.com/authorize",
        tokenUrl: "https://issuer.example.com/token",
        pkce: "S256",
      }),
    )
    const result = await discoverOidc("https://issuer.example.com")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.design.authorizationUrl).toBe("https://issuer.example.com/authorize")
      expect(result.design.tokenUrl).toBe("https://issuer.example.com/token")
    }
    expect(fetchOidcDiscoveryMock).toHaveBeenCalledWith("https://issuer.example.com")
  })

  it("a non-2xx failure maps to a human-readable {ok:false} message", async () => {
    fetchOidcDiscoveryMock.mockReturnValue(errAsync({ kind: "non-2xx", status: 404 }))
    const result = await discoverOidc("https://issuer.example.com")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("404")
  })

  it("an unreachable failure maps to a human-readable {ok:false} message", async () => {
    fetchOidcDiscoveryMock.mockReturnValue(errAsync({ kind: "unreachable", detail: "TypeError" }))
    const result = await discoverOidc("https://issuer.example.com")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("Couldn't reach")
  })
})

describe("mutateAddCustomDesign / mutateDeleteCustomDesign", () => {
  let tmpHome: string
  let prevHome: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "junction-web-design-test-"))
    prevHome = process.env.JUNCTION_HOME
    process.env.JUNCTION_HOME = tmpHome
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    await rm(tmpHome, { recursive: true, force: true })
  })

  const design = {
    id: "custom:acme-oauth",
    displayName: "Acme OAuth",
    authorizationUrl: "https://acme.example.com/oauth/authorize",
    tokenUrl: "https://acme.example.com/oauth/token",
    scopeSeparator: " ",
    pkce: "S256",
    supportsRefresh: true,
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    registrationHint: { redirectUri: "", scopes: "", docsUrl: "" },
  }

  it("add persists a valid design; delete on it (unreferenced) succeeds", async () => {
    const added = await mutateAddCustomDesign(design)
    expect(added.ok).toBe(true)
    if (added.ok) expect(added.design.id).toBe("custom:acme-oauth")

    const deleted = await mutateDeleteCustomDesign("custom:acme-oauth")
    expect(deleted.ok).toBe(true)
  })

  it("add rejects a non-custom:-prefixed id (fails schema validation before any builtin-collision check)", async () => {
    // "github" fails CustomOAuthDesignSchema's `custom:` prefix regex first —
    // builtin-collision is structurally unreachable via this public op (see
    // core's design-ops.test.ts for the direct schema-bypass proof), so the
    // observable behavior here is the generic invalid-design message.
    const result = await mutateAddCustomDesign({ ...design, id: "github" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("doesn't validate")
  })

  it("delete on a REFERENCED design refuses, naming the referring platform", async () => {
    await mutateAddCustomDesign(design)

    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)
    const platformId = newPlatformId()
    await repos.platforms.create({
      id: platformId,
      kind: "mcp",
      displayName: "Acme via custom design",
      oauthProviderId: "custom:acme-oauth",
    })

    const result = await mutateDeleteCustomDesign("custom:acme-oauth")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(String(platformId))
      expect(result.error).toContain("referenced")
    }
  })

  it("delete on a built-in id refuses with not-custom messaging", async () => {
    const result = await mutateDeleteCustomDesign("github")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("built-in")
  })
})

// The token-URL confirmation is a SECURITY control (the tokenUrl is the refresh-
// token-exfil surface). It must be enforced at the SERVER-FN validator (the trust
// boundary), not only in the React form — else a local agent POSTing directly to
// the server-fn could create a design with an unconfirmed/attacker tokenUrl.
// (credential-security review, inc 45.)
describe("assertTokenUrlConfirmed — server-side token-URL confirmation gate", () => {
  const tokenUrl = "https://acme.test/token"

  it("REJECTS when confirmedTokenUrl is absent (undefined)", () => {
    expect(() => assertTokenUrlConfirmed(undefined, tokenUrl)).toThrow()
  })

  it("REJECTS when confirmedTokenUrl does NOT match tokenUrl", () => {
    expect(() => assertTokenUrlConfirmed("https://evil.test/token", tokenUrl)).toThrow()
  })

  it("ACCEPTS when confirmedTokenUrl matches tokenUrl exactly", () => {
    expect(() => assertTokenUrlConfirmed(tokenUrl, tokenUrl)).not.toThrow()
  })
})
