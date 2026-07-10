// SPDX-License-Identifier: AGPL-3.0-only
// App grouping tests — positive + negative attribution controls, the
// multi-account wedge, and the public/no-credential connection shape.
// Method file §2a / §3 proof-of-done.

import { describe, expect, it } from "vitest"
import type { AppDefinition } from "./catalog.js"
import { listApps } from "./catalog.js"
import { appIdForConnection, groupByApp } from "./group.js"

// A minimal synthetic catalog for tests that need more than one app (the real
// catalog is github-only since the inc 35 strip-down — see
// docs/methods/35-catalog-stripdown.md).
//
// "-search" is deliberately NOT one of group.ts's BUILD_KIND_SUFFIXES
// (mcp/openapi/graphql/http/cli), so brave-search proves exact-id matching
// wins for a hyphenated id without the suffix-strip logic ever getting a
// chance to misfire on it. gitlab-oauth stands in for a second, DIFFERENT
// oauth2-backed app (its providerId doesn't need to resolve in the real
// oauth/catalog.ts — appIdForConnection's step 1 only needs the App's own
// auth[] to declare it).
const SYNTHETIC_APPS: AppDefinition[] = [
  {
    id: "brave-search",
    displayName: "Brave Search",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
  },
  {
    id: "gitlab-oauth",
    displayName: "GitLab (synthetic)",
    supportedKinds: ["graphql"],
    auth: [{ mode: "oauth2", providerId: "gitlab-oauth" }],
  },
  {
    // Stands in for a surface-less oauth2 app (the 30.8 motivating case,
    // formerly demonstrated with "google") — supportedKinds without a ready
    // surfaces[] entry. Proves groupByApp reads app-level auth[] only, never
    // `surfaces` (this AppDefinition has no `surfaces` field at all).
    id: "surfaceless-oauth-app",
    displayName: "Surface-less OAuth App (synthetic)",
    supportedKinds: ["openapi"],
    auth: [{ mode: "oauth2", providerId: "surfaceless-oauth-app" }],
  },
  {
    // Stands in for a surface-less byo/escape-hatch app (formerly "wpgraphql").
    id: "byo-graphql-app",
    displayName: "BYO GraphQL App (synthetic)",
    supportedKinds: ["graphql"],
    auth: [{ mode: "byo" }],
  },
]

const BUILD_KIND_SUFFIXES = ["mcp", "openapi", "graphql", "http", "cli"] as const

describe("catalog invariant (30.12 A5): no app id or alias ends in a build-kind suffix", () => {
  // The <appId>-<kind> suffix-strip rule in appIdForConnection is only
  // unambiguously reversible as long as no REAL app id (or alias) happens to
  // end in one of the 5 build-recipe kind suffixes — otherwise the strip
  // would mis-resolve a genuine id to the wrong (or a nonexistent) app. This
  // test fails LOUDLY the moment a future catalog entry would break that
  // invariant, rather than silently mis-grouping in production.
  it("no listApps() id ends in a build-kind suffix", () => {
    const apps = listApps()
    for (const app of apps) {
      for (const kind of BUILD_KIND_SUFFIXES) {
        expect(app.id.toLowerCase().endsWith(`-${kind}`)).toBe(false)
      }
    }
  })

  it("no alias ends in a build-kind suffix", () => {
    const apps = listApps()
    for (const app of apps) {
      for (const alias of app.aliases ?? []) {
        for (const kind of BUILD_KIND_SUFFIXES) {
          expect(alias.toLowerCase().endsWith(`-${kind}`)).toBe(false)
        }
      }
    }
  })
})

describe("appIdForConnection", () => {
  it("POSITIVE: oauthProviderId is authoritative — resolves via the auth[] providerId link", () => {
    const appId = appIdForConnection({
      platformId: "totally-different-id",
      platformDisplayName: "Whatever",
      kind: "mcp",
      oauthProviderId: "github",
    })
    expect(appId).toBe("github")
  })

  it("NEGATIVE (id heuristic, positive case): a bearer platform whose id exactly matches an app id groups under that app", () => {
    const appId = appIdForConnection({
      platformId: "github",
      platformDisplayName: "My GitHub REST",
      kind: "openapi",
    })
    expect(appId).toBe("github")
  })

  it("id match is case-insensitive", () => {
    const appId = appIdForConnection({
      platformId: "GitHub",
      platformDisplayName: "irrelevant",
      kind: "openapi",
    })
    expect(appId).toBe("github")
  })

  it("alias match: 'gh' resolves to github", () => {
    const appId = appIdForConnection({
      platformId: "gh",
      platformDisplayName: "irrelevant",
      kind: "cli",
    })
    expect(appId).toBe("github")
  })

  it("displayName match: exact, case-insensitive against the app's displayName", () => {
    const appId = appIdForConnection({
      platformId: "some-internal-id",
      platformDisplayName: "GitHub",
      kind: "cli",
    })
    expect(appId).toBe("github")
  })

  it("NEGATIVE: a bearer platform whose id does NOT match any app lands in 'other' (asserted, not pretended)", () => {
    const appId = appIdForConnection({
      platformId: "totally-unrelated",
      platformDisplayName: "Totally Unrelated",
      kind: "openapi",
    })
    expect(appId).toBe("other")
  })

  it("no fuzzy/substring matching: 'githubx' does NOT match 'github'", () => {
    const appId = appIdForConnection({
      platformId: "githubx",
      platformDisplayName: "GitHub Extended",
      kind: "openapi",
    })
    expect(appId).toBe("other")
  })

  it("never returns undefined", () => {
    const appId = appIdForConnection({
      platformId: "",
      platformDisplayName: "",
      kind: "custom",
    })
    expect(appId).toBe("other")
    expect(appId).not.toBeUndefined()
  })

  it("SUFFIX-STRIP (30.12): github-mcp/openapi/graphql/http/cli all resolve to 'github'", () => {
    for (const kind of ["mcp", "openapi", "graphql", "http", "cli"] as const) {
      const appId = appIdForConnection({
        platformId: `github-${kind}`,
        platformDisplayName: "irrelevant",
        kind,
      })
      expect(appId).toBe("github")
    }
  })

  it("SUFFIX-STRIP negative control: a hyphenated app id resolves via exact-id, NOT mis-stripped at the hyphen", () => {
    const appId = appIdForConnection(
      {
        platformId: "brave-search",
        platformDisplayName: "irrelevant",
        kind: "openapi",
      },
      SYNTHETIC_APPS,
    )
    expect(appId).toBe("brave-search")
  })

  it("SUFFIX-STRIP: a made-up 'foo-custom' is NOT stripped ('custom' is not in the closed build-kind suffix set) — lands in 'other'", () => {
    const appId = appIdForConnection({
      platformId: "foo-custom",
      platformDisplayName: "irrelevant",
      kind: "custom",
    })
    expect(appId).toBe("other")
  })

  it("PRECEDENCE: an oauthProviderId that NO app declares FALLS THROUGH to id-matching (not early 'other')", () => {
    // Load-bearing contract: step 1 is a guarded return, not an unconditional
    // early return under `if (oauthProviderId)`. A regression to the latter would
    // pass every other test but break every token platform carrying a stale
    // providerId. Here the bogus providerId must be ignored and the exact id
    // match ("github") must win.
    const appId = appIdForConnection({
      platformId: "github",
      platformDisplayName: "irrelevant",
      kind: "openapi",
      oauthProviderId: "no-such-provider",
    })
    expect(appId).toBe("github")
  })
})

describe("groupByApp", () => {
  it("POSITIVE control: a GitHub platform + a GitHub oauth credential groups under 'github'", () => {
    const groups = groupByApp({
      platforms: [{ id: "github", kind: "mcp", displayName: "GitHub" }],
      credentials: [{ platformId: "github", account: "work", oauthProviderId: "github" }],
    })
    const githubGroup = groups.find((g) => g.appId === "github")
    expect(githubGroup).toBeDefined()
    expect(githubGroup?.connections).toEqual([
      { appId: "github", account: "work", platformId: "github", kind: "mcp" },
    ])
  })

  it("NEGATIVE control: a bearer-authed platform whose id exactly matches groups via the id heuristic", () => {
    const groups = groupByApp({
      platforms: [{ id: "github", kind: "openapi", displayName: "GitHub REST" }],
      credentials: [{ platformId: "github", account: "personal" }],
    })
    const githubGroup = groups.find((g) => g.appId === "github")
    expect(githubGroup).toBeDefined()
    expect(githubGroup?.connections).toHaveLength(1)
    expect(githubGroup?.connections[0]?.account).toBe("personal")
  })

  it("NEGATIVE control: a bearer platform with a non-matching id lands in 'other' (asserted)", () => {
    const groups = groupByApp({
      platforms: [{ id: "totally-unrelated", kind: "openapi", displayName: "Totally Unrelated" }],
      credentials: [{ platformId: "totally-unrelated", account: "default" }],
    })
    const other = groups.find((g) => g.appId === "other")
    const github = groups.find((g) => g.appId === "github")
    expect(other).toBeDefined()
    expect(other?.connections).toHaveLength(1)
    expect(github).toBeUndefined()
  })

  it("WEDGE: two credentials (work/personal) on one platform yield two connections in the group", () => {
    const groups = groupByApp({
      platforms: [{ id: "github", kind: "mcp", displayName: "GitHub" }],
      credentials: [
        { platformId: "github", account: "work", oauthProviderId: "github" },
        { platformId: "github", account: "personal", oauthProviderId: "github" },
      ],
    })
    const githubGroup = groups.find((g) => g.appId === "github")
    expect(githubGroup?.connections).toHaveLength(2)
    expect(githubGroup?.connections.map((c) => c.account).sort()).toEqual(["personal", "work"])
  })

  it("PUBLIC: a platform with no credentials yields one credential-less connection (account '—')", () => {
    const groups = groupByApp({
      platforms: [{ id: "github", kind: "mcp", displayName: "GitHub" }],
      credentials: [],
    })
    const group = groups.find((g) => g.appId === "github")
    expect(group).toBeDefined()
    expect(group?.connections).toEqual([
      { appId: "github", account: "—", platformId: "github", kind: "mcp" },
    ])
  })

  it("every connection lands in exactly one group — no drops, no duplicates", () => {
    const groups = groupByApp({
      platforms: [
        { id: "github", kind: "mcp", displayName: "GitHub" },
        { id: "unmatched-one", kind: "cli", displayName: "Unmatched One" },
      ],
      credentials: [
        { platformId: "github", account: "work", oauthProviderId: "github" },
        { platformId: "github", account: "personal", oauthProviderId: "github" },
        { platformId: "unmatched-one", account: "default" },
      ],
    })
    const totalConnections = groups.reduce((sum, g) => sum + g.connections.length, 0)
    expect(totalConnections).toBe(3)
  })

  it("DIVERGENT wedge: two creds on one platform with different providerIds split across their app groups (per-connection grain, intended)", () => {
    // A pathological-but-possible case: one platform row carrying two OAuth
    // credentials for DIFFERENT services. Attribution is per-connection and the
    // authoritative providerId wins, so the platform legitimately appears under
    // BOTH app headers. Pinned as intended behavior (per-connection grain), not
    // a surprise — see the correctness review (inc 30 Slice A). Uses the
    // synthetic 2nd app (gitlab-oauth) alongside the real 'github' app since
    // the catalog is github-only post-strip-down.
    const apps = [...listApps(), ...SYNTHETIC_APPS]
    const groups = groupByApp(
      {
        platforms: [{ id: "shared-host", kind: "graphql", displayName: "Shared Host" }],
        credentials: [
          { platformId: "shared-host", account: "gh", oauthProviderId: "github" },
          { platformId: "shared-host", account: "gl", oauthProviderId: "gitlab-oauth" },
        ],
      },
      apps,
    )
    expect(groups.find((g) => g.appId === "github")?.connections).toHaveLength(1)
    expect(groups.find((g) => g.appId === "gitlab-oauth")?.connections).toHaveLength(1)
  })

  it("ORPHAN credential (platformId absent from platforms) is silently dropped — documented, FK-guaranteed unreachable", () => {
    // group.ts iterates platforms and looks creds up by platform.id; a cred
    // whose platformId isn't in the platforms list is never visited. This is
    // acknowledged in-code (staying pure over throwing) and safe because the DB
    // FK + the web readApps caller (loads ALL platforms + ALL credentials)
    // guarantee platforms ⊇ credential.platformIds. Pinned so a loop refactor
    // can't silently change it.
    const groups = groupByApp({
      platforms: [{ id: "github", kind: "mcp", displayName: "GitHub" }],
      credentials: [
        { platformId: "github", account: "work", oauthProviderId: "github" },
        { platformId: "ghost", account: "orphan" },
      ],
    })
    const total = groups.reduce((sum, g) => sum + g.connections.length, 0)
    expect(total).toBe(1)
    expect(groups.some((g) => g.connections.some((c) => c.account === "orphan"))).toBe(false)
  })

  it("SURFACE-LESS (30.8): an oauth2 app with zero surfaces[] still groups via its oauth2 providerId", () => {
    // The design doc's motivating bug (§1) — an app can ship oauth2 +
    // supportedKinds without a ready surface (surfaces are optional; only
    // GitHub is fully authored post-strip-down). Proof-of-done: a surface-less
    // catalog entry must still resolve through groupByApp exactly like a
    // surfaced one — grouping reads app-level auth[] only, never `surfaces`.
    const apps = [...listApps(), ...SYNTHETIC_APPS]
    const groups = groupByApp(
      {
        platforms: [{ id: "some-surfaceless-platform", kind: "openapi", displayName: "My App" }],
        credentials: [
          {
            platformId: "some-surfaceless-platform",
            account: "work",
            oauthProviderId: "surfaceless-oauth-app",
          },
        ],
      },
      apps,
    )
    const group = groups.find((g) => g.appId === "surfaceless-oauth-app")
    expect(group).toBeDefined()
    expect(group?.connections).toHaveLength(1)
  })

  it("SURFACE-LESS (30.8): the byo escape-hatch app (zero surfaces[]) still groups by id", () => {
    const apps = [...listApps(), ...SYNTHETIC_APPS]
    const groups = groupByApp(
      {
        platforms: [{ id: "byo-graphql-app", kind: "graphql", displayName: "BYO GraphQL App" }],
        credentials: [{ platformId: "byo-graphql-app", account: "default" }],
      },
      apps,
    )
    const group = groups.find((g) => g.appId === "byo-graphql-app")
    expect(group).toBeDefined()
    expect(group?.connections).toHaveLength(1)
  })

  it("does NOT emit a catalog app with zero connections", () => {
    const groups = groupByApp({
      platforms: [{ id: "totally-unrelated", kind: "cli", displayName: "Totally Unrelated" }],
      credentials: [{ platformId: "totally-unrelated", account: "default" }],
    })
    // "github" is a real catalog app but has no connection in this input —
    // it must not appear as an emitted group here (the /app index left-joins
    // listApps() separately for browsable-but-unconnected apps).
    expect(groups.find((g) => g.appId === "github")).toBeUndefined()
  })
})
