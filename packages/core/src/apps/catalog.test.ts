// SPDX-License-Identifier: AGPL-3.0-only
// App catalog tests — pure data lookups + catalog-integrity (every oauth2
// providerId must resolve against the OAuth provider catalog). Reduced to
// github-only in increment 35 (catalog strip-down) — the other ~53 apps are
// reintroduced properly, one at a time, starting increment 36.

import { describe, expect, it } from "vitest"
import { getProvider, listProviders } from "../oauth/catalog.js"
import { getApp, listApps } from "./catalog.js"

describe("getApp / listApps", () => {
  it("getApp returns undefined for an unknown id", () => {
    expect(getApp("nope")).toBeUndefined()
  })

  it("getApp returns undefined for the synthetic 'other' bucket (not a catalog app)", () => {
    expect(getApp("other")).toBeUndefined()
  })

  it("listApps returns exactly the github-only catalog (inc 35 strip-down)", () => {
    const ids = listApps().map((a) => a.id)
    expect(ids).toEqual(["github"])
  })

  it("github: multiple auth modes (two oauth2 variants + token)", () => {
    const github = getApp("github")
    expect(github).toBeDefined()
    if (!github) return
    expect(github.supportedKinds).toEqual(
      expect.arrayContaining(["mcp", "cli", "openapi", "graphql"]),
    )
    expect(github.auth.some((a) => a.mode === "oauth2" && a.providerId === "github")).toBe(true)
    expect(github.auth.some((a) => a.mode === "oauth2" && a.providerId === "github-app")).toBe(true)
    expect(github.auth.some((a) => a.mode === "token")).toBe(true)
    expect(github.aliases).toContain("gh")
  })

  it("does not seed the dead SpaceX GraphQL entry", () => {
    expect(getApp("spacex")).toBeUndefined()
  })

  it("does not seed the unverified Hashnode GraphQL entry", () => {
    expect(getApp("hashnode")).toBeUndefined()
  })

  it("'oauth' is never a supportedKinds member (it's an auth mode, not a PlatformKind)", () => {
    for (const app of listApps()) {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately probing for a banned string literal outside the PlatformKind union
      expect(app.supportedKinds as any).not.toContain("oauth")
    }
  })
})

describe("catalog integrity", () => {
  it("every oauth2 auth entry's providerId resolves via getProvider", () => {
    for (const app of listApps()) {
      for (const auth of app.auth) {
        if (auth.mode === "oauth2") {
          expect(
            getProvider(auth.providerId),
            `${app.id}: providerId "${auth.providerId}"`,
          ).toBeDefined()
        }
      }
    }
  })

  it("every non-generic OAuth provider is covered by an App (else a real OAuth connection mis-groups to 'Other')", () => {
    // Regression guard for the inc-30 real-server-QA bug: a shipped OAuth
    // provider (google) had no App entry, so a dogfooded Google connection
    // landed in "Other" and /app/google 404'd. Every connectable provider must
    // have a first-class App whose auth[] links to it.
    const apps = listApps()
    for (const provider of listProviders()) {
      if (provider.id === "generic") continue // the BYO escape hatch has no fixed App
      const covered = apps.some((app) =>
        app.auth.some((a) => a.mode === "oauth2" && a.providerId === provider.id),
      )
      expect(covered, `OAuth provider "${provider.id}" has no App entry`).toBe(true)
    }
  })

  it("every app has at least one auth entry", () => {
    for (const app of listApps()) {
      expect(app.auth.length, `${app.id} has no auth entries`).toBeGreaterThan(0)
    }
  })

  it("app ids are unique", () => {
    const ids = listApps().map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
