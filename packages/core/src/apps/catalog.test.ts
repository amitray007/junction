// SPDX-License-Identifier: AGPL-3.0-only
// App catalog tests — pure data lookups + catalog-integrity (every oauth2
// providerId must resolve against the OAuth provider catalog).

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

  it("listApps includes the well-known seeded apps", () => {
    const ids = listApps().map((a) => a.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "github",
        "gitlab",
        "notion",
        "linear",
        "atlassian",
        "discord",
        "spotify",
        "zoom",
        "dropbox",
        "figma",
        "stripe",
      ]),
    )
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

  it("notion: OAuth (hosted integration) + token (internal integration), OAuth first", () => {
    const notion = getApp("notion")
    expect(notion).toBeDefined()
    if (!notion) return
    expect(notion.auth).toEqual([{ mode: "oauth2", providerId: "notion" }, { mode: "token" }])
  })

  it("figma: both a 'none' (local MCP) and an 'oauth2' (REST API) auth mode", () => {
    const figma = getApp("figma")
    expect(figma).toBeDefined()
    if (!figma) return
    expect(figma.auth.some((a) => a.mode === "none")).toBe(true)
    expect(figma.auth.some((a) => a.mode === "oauth2" && a.providerId === "figma")).toBe(true)
  })

  it("no app lists 'slack' MCP support (unverified package — omitted per research doc)", () => {
    const slack = getApp("slack")
    // Slack itself isn't seeded in this pass (no confirmed MCP package + the
    // shipped oauth provider is exercised via the "other"/id-heuristic tests
    // in group.test.ts) — this asserts the catalog stays honest either way:
    // if a future pass adds "slack", it must not claim "mcp".
    if (slack) {
      expect(slack.supportedKinds).not.toContain("mcp")
    }
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
