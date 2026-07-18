// SPDX-License-Identifier: AGPL-3.0-only
// resolveOAuthProviderId tests (increment 44 Phase 3, R3) — the shared
// primitive refresh + grouping both consume. Pure/synchronous, no I/O — plain
// unit tests, no DB/store involved.

import { describe, expect, it, vi } from "vitest"
import { resolveOAuthProviderId } from "./resolve-provider-id.js"

describe("resolveOAuthProviderId", () => {
  it("platform.oauthProviderId set + a real catalog design → uses it, no fallback fired", () => {
    const onFallback = vi.fn()
    const result = resolveOAuthProviderId({
      credentialId: "cred_1",
      context: "refresh",
      platform: { id: "plat_1", oauthProviderId: "github" },
      legacyProviderId: "google", // present but must NOT be used — platform wins
      onFallback,
    })
    expect(result).toEqual({ ok: true, providerId: "github" })
    expect(onFallback).not.toHaveBeenCalled()
  })

  it("SECURITY: platform.oauthProviderId set but DANGLING (no such design) → fails closed, never falls back", () => {
    const onFallback = vi.fn()
    const result = resolveOAuthProviderId({
      credentialId: "cred_1",
      context: "refresh",
      platform: { id: "plat_1", oauthProviderId: "attacker-controlled-design" },
      legacyProviderId: "github", // present — must be IGNORED; fail closed, not fall through
      onFallback,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      kind: "dangling-provider-reference",
      platformId: "plat_1",
      providerId: "attacker-controlled-design",
    })
    expect(onFallback).not.toHaveBeenCalled()
  })

  it("no platform.oauthProviderId, but an app-catalog auth[].providerId is resolved → uses it, no fallback fired", () => {
    const onFallback = vi.fn()
    const result = resolveOAuthProviderId({
      credentialId: "cred_1",
      context: "group",
      platform: { id: "plat_1" },
      appAuthProviderId: "slack",
      legacyProviderId: "github",
      onFallback,
    })
    expect(result).toEqual({ ok: true, providerId: "slack" })
    expect(onFallback).not.toHaveBeenCalled()
  })

  it("no platform reference, no app-catalog source → falls back to legacy providerId AND fires onFallback with the context tag", () => {
    const onFallback = vi.fn()
    const result = resolveOAuthProviderId({
      credentialId: "cred_1",
      context: "refresh",
      platform: { id: "plat_1" },
      legacyProviderId: "github",
      onFallback,
    })
    expect(result).toEqual({ ok: true, providerId: "github" })
    expect(onFallback).toHaveBeenCalledExactlyOnceWith({
      context: "refresh",
      credentialId: "cred_1",
      providerId: "github",
      reason: "unset",
    })
  })

  it("context tag is threaded through to onFallback verbatim ('group')", () => {
    const onFallback = vi.fn()
    resolveOAuthProviderId({
      credentialId: "cred_2",
      context: "group",
      platform: null,
      legacyProviderId: "google",
      onFallback,
    })
    expect(onFallback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ context: "group" }),
    )
  })

  it("orphan credential (no platform at all) → falls back to legacy providerId", () => {
    const onFallback = vi.fn()
    const result = resolveOAuthProviderId({
      credentialId: "cred_orphan",
      context: "refresh",
      platform: null,
      legacyProviderId: "github",
      onFallback,
    })
    expect(result).toEqual({ ok: true, providerId: "github" })
    expect(onFallback).toHaveBeenCalledOnce()
  })

  it("no provider source anywhere → typed no-provider-source error, no fallback fired (nothing to fall back to)", () => {
    const onFallback = vi.fn()
    const result = resolveOAuthProviderId({
      credentialId: "cred_3",
      context: "refresh",
      platform: { id: "plat_1" },
      onFallback,
    })
    expect(result).toEqual({
      ok: false,
      error: { kind: "no-provider-source", credentialId: "cred_3" },
    })
    expect(onFallback).not.toHaveBeenCalled()
  })

  it("onFallback is optional — omitting it does not throw when the fallback fires", () => {
    expect(() =>
      resolveOAuthProviderId({
        credentialId: "cred_4",
        context: "refresh",
        platform: undefined,
        legacyProviderId: "github",
      }),
    ).not.toThrow()
  })
})
