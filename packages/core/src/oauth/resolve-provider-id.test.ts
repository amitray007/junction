// SPDX-License-Identifier: AGPL-3.0-only
// resolveOAuthProviderId tests (increment 44 Phase 3, R3; narrowed increment
// 45 Slice E — the legacy `oauthMeta.providerId` fallback arm is GONE) — the
// shared primitive refresh + grouping both consume. Pure/synchronous, no I/O
// — plain unit tests, no DB/store involved.

import { describe, expect, it, vi } from "vitest"
import { mergeDesigns } from "./catalog.js"
import { resolveOAuthProviderId } from "./resolve-provider-id.js"

// increment 45 (D2) — the resolver now takes the merged design lookup as
// data. These tests only exercise built-in ids (github/google/slack), so an
// empty custom list is enough — `mergeDesigns([])` is just the built-in
// catalog. designs-store.test.ts / catalog.test.ts cover the custom-design
// merge behavior itself.
const BUILT_INS_ONLY = mergeDesigns([])

describe("resolveOAuthProviderId", () => {
  it("platform.oauthProviderId set + a real catalog design → uses it", () => {
    const result = resolveOAuthProviderId({
      credentialId: "cred_1",
      context: "refresh",
      platform: { id: "plat_1", oauthProviderId: "github" },
      designs: BUILT_INS_ONLY,
    })
    expect(result).toEqual({ ok: true, providerId: "github" })
  })

  it("SECURITY: platform.oauthProviderId set but DANGLING (no such design) → fails closed", () => {
    const result = resolveOAuthProviderId({
      credentialId: "cred_1",
      context: "refresh",
      platform: { id: "plat_1", oauthProviderId: "attacker-controlled-design" },
      designs: BUILT_INS_ONLY,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      kind: "dangling-provider-reference",
      platformId: "plat_1",
      providerId: "attacker-controlled-design",
    })
  })

  it("no platform.oauthProviderId, but an app-catalog auth[].providerId is resolved → uses it", () => {
    const result = resolveOAuthProviderId({
      credentialId: "cred_1",
      context: "group",
      platform: { id: "plat_1" },
      appAuthProviderId: "slack",
      designs: BUILT_INS_ONLY,
    })
    expect(result).toEqual({ ok: true, providerId: "slack" })
  })

  it("increment 45 Slice E: no platform reference, no app-catalog source → no-provider-source (the legacy fallback arm is GONE)", () => {
    const result = resolveOAuthProviderId({
      credentialId: "cred_1",
      context: "refresh",
      platform: { id: "plat_1" },
      designs: BUILT_INS_ONLY,
    })
    expect(result).toEqual({
      ok: false,
      error: { kind: "no-provider-source", credentialId: "cred_1" },
    })
  })

  it("increment 45 Slice E: orphan credential (no platform at all) → no-provider-source, not a fallback", () => {
    const result = resolveOAuthProviderId({
      credentialId: "cred_orphan",
      context: "refresh",
      platform: null,
      designs: BUILT_INS_ONLY,
    })
    expect(result).toEqual({
      ok: false,
      error: { kind: "no-provider-source", credentialId: "cred_orphan" },
    })
  })

  it("no provider source anywhere → typed no-provider-source error", () => {
    const result = resolveOAuthProviderId({
      credentialId: "cred_3",
      context: "refresh",
      platform: { id: "plat_1" },
      designs: BUILT_INS_ONLY,
    })
    expect(result).toEqual({
      ok: false,
      error: { kind: "no-provider-source", credentialId: "cred_3" },
    })
  })

  it("platform undefined (not just null) behaves the same as no platform → no-provider-source", () => {
    const result = resolveOAuthProviderId({
      credentialId: "cred_4",
      context: "refresh",
      platform: undefined,
      designs: BUILT_INS_ONLY,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: "no-provider-source", credentialId: "cred_4" })
  })

  // ---------------------------------------------------------------------------
  // increment 45 (D2/D3) — a custom:<slug> design present in the MERGED set
  // ---------------------------------------------------------------------------

  it("increment 45: a custom:<slug> id present in the merged designs set resolves ok, same as a built-in", () => {
    const customDesign = {
      id: "custom:acme-oauth",
      displayName: "Acme OAuth",
      authorizationUrl: "https://acme.example.com/oauth/authorize",
      tokenUrl: "https://acme.example.com/oauth/token",
      scopeSeparator: " " as const,
      pkce: "S256" as const,
      supportsRefresh: true,
      expiryStrategy: "expires_in" as const,
      redirectMode: "loopback-fixed" as const,
      registrationHint: { redirectUri: "", scopes: "", docsUrl: "" },
    }
    const designs = mergeDesigns([customDesign])
    const result = resolveOAuthProviderId({
      credentialId: "cred_5",
      context: "refresh",
      platform: { id: "plat_1", oauthProviderId: "custom:acme-oauth" },
      designs,
    })
    expect(result).toEqual({ ok: true, providerId: "custom:acme-oauth" })
  })

  it("increment 45: a custom:<slug> id NOT present in the merged designs set still fails closed (dangling-provider-reference)", () => {
    const result = resolveOAuthProviderId({
      credentialId: "cred_6",
      context: "refresh",
      platform: { id: "plat_1", oauthProviderId: "custom:never-created" },
      designs: BUILT_INS_ONLY,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      kind: "dangling-provider-reference",
      platformId: "plat_1",
      providerId: "custom:never-created",
    })
  })

  it("does not throw or reference an onFallback-shaped callback (the fallback mechanism no longer exists)", () => {
    const spy = vi.fn()
    expect(() =>
      resolveOAuthProviderId({
        credentialId: "cred_7",
        context: "refresh",
        platform: { id: "plat_1" },
        designs: BUILT_INS_ONLY,
      }),
    ).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })
})
