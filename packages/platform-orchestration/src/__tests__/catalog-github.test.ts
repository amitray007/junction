// SPDX-License-Identifier: AGPL-3.0-only
// Structural test: the catalog's GitHub openapi surface maps to a valid
// AddOpenApiPlatformInput shape (increment 30.8, method file §3/§6). Lives
// HERE (platform-orchestration, which may import core) rather than in core,
// per the method file's explicit package placement rule — importing
// AddOpenApiPlatformInput INTO a core test would invert the dependency
// direction (core must import nothing in-repo; junction-package-boundary
// would flag it).
//
// This asserts the openapi FIELDS ONLY (specUrl/baseUrl/verifyOperationId) —
// it deliberately does NOT route the surface's oauth2 auth through
// buildPlatformAuth (§5 "known gap": oauth2 is not a settable AuthInput.scheme;
// it's derived from a spec or injected as a bearer credential — a LATER
// increment's connect interpreter concern, not this one's to execute).

import { getApp, getCatalogEntry } from "@junction/core"
import { describe, expect, it } from "vitest"
import type { AddOpenApiPlatformInput } from "../openapi.js"

describe("catalog GitHub entry — openapi surface structural mapping", () => {
  const entry = getCatalogEntry("github")

  it("GitHub's catalog entry exists and carries all 5 surfaces (incl. http present-but-empty)", () => {
    expect(entry).toBeDefined()
    expect(entry?.surfaces).toHaveLength(5)
    const kinds = entry?.surfaces?.map((s) => s.kind).sort()
    expect(kinds).toEqual(["cli", "graphql", "http", "mcp", "openapi"])
  })

  it("the http surface is PRESENT but ships no starterTools (gap-filler rule — OpenAPI covers REST)", () => {
    const http = entry?.surfaces?.find((s) => s.kind === "http")
    expect(http).toBeDefined()
    expect(http?.starterTools).toBeUndefined()
    expect(http?.verify).toEqual({ kind: "none" })
  })

  it("the openapi surface's connection FIELDS map onto a valid AddOpenApiPlatformInput shape", () => {
    const openapi = entry?.surfaces?.find((s) => s.kind === "openapi")
    expect(openapi).toBeDefined()
    if (openapi?.connection.kind !== "openapi") return

    // Map ONLY the fields (specUrl/baseUrl/verifyOperationId) — no auth routing.
    // `auth` is deliberately omitted: passing the surface's oauth2 auth through
    // buildPlatformAuth would throw ("Unknown auth scheme oauth2" — oauth2 is
    // derived from the spec, not a settable AuthInput.scheme). Absent `auth`
    // means addOpenApiPlatform falls back to deriveAuthFromSpec, which is the
    // real inc-29 behavior for a GitHub OAuth connection.
    const input: AddOpenApiPlatformInput = {
      id: "github",
      displayName: entry.displayName,
      specUrl: openapi.connection.specUrl,
      baseUrl: openapi.connection.baseUrl,
      verifyOperationId: openapi.connection.verifyOperationId,
    }

    expect(input.specUrl).toBe(
      "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    )
    expect(input.baseUrl).toBe("https://api.github.com")
    expect(input.verifyOperationId).toBe("users/get-authenticated")
  })

  it("preserves ALL THREE app-level auth providers (github, github-app, token) — proof-of-done", () => {
    // The re-authored GitHub entry must not drop github-app: the inc-30
    // reverse-coverage guard (core's catalog.test.ts) covers github-app ONLY
    // via GitHub's app-level auth[].
    const app = getApp("github")
    expect(app).toBeDefined()
    expect(app?.auth.some((a) => a.mode === "oauth2" && a.providerId === "github")).toBe(true)
    expect(app?.auth.some((a) => a.mode === "oauth2" && a.providerId === "github-app")).toBe(true)
    expect(app?.auth.some((a) => a.mode === "token")).toBe(true)
    expect(app?.auth).toHaveLength(3)
  })
})
