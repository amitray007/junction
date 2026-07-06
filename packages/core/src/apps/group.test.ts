// SPDX-License-Identifier: AGPL-3.0-only
// App grouping tests — positive + negative attribution controls, the
// multi-account wedge, and the public/no-credential connection shape.
// Method file §2a / §3 proof-of-done.

import { describe, expect, it } from "vitest"
import { appIdForConnection, groupByApp } from "./group.js"

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
      platforms: [{ id: "filesystem", kind: "mcp", displayName: "Filesystem" }],
      credentials: [],
    })
    const group = groups.find((g) => g.appId === "filesystem")
    expect(group).toBeDefined()
    expect(group?.connections).toEqual([
      { appId: "filesystem", account: "—", platformId: "filesystem", kind: "mcp" },
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
    // a surprise — see the correctness review (inc 30 Slice A).
    const groups = groupByApp({
      platforms: [{ id: "shared-host", kind: "graphql", displayName: "Shared Host" }],
      credentials: [
        { platformId: "shared-host", account: "gh", oauthProviderId: "github" },
        { platformId: "shared-host", account: "gl", oauthProviderId: "gitlab" },
      ],
    })
    expect(groups.find((g) => g.appId === "github")?.connections).toHaveLength(1)
    expect(groups.find((g) => g.appId === "gitlab")?.connections).toHaveLength(1)
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

  it("SURFACE-LESS (30.8): Google (oauth2 + openapi, zero surfaces[]) still groups via its oauth2 providerId", () => {
    // The design doc's motivating bug (§1) — Google ships oauth2 + supportedKinds
    // ["openapi"] but no ready surface in THIS increment (surfaces are optional;
    // only GitHub is fully authored). Proof-of-done: a surface-less catalog
    // entry must still resolve through groupByApp exactly like a surfaced one —
    // grouping reads app-level auth[] only, never `surfaces`.
    const groups = groupByApp({
      platforms: [{ id: "some-google-platform", kind: "openapi", displayName: "My Google" }],
      credentials: [
        { platformId: "some-google-platform", account: "work", oauthProviderId: "google" },
      ],
    })
    const googleGroup = groups.find((g) => g.appId === "google")
    expect(googleGroup).toBeDefined()
    expect(googleGroup?.connections).toHaveLength(1)
  })

  it("SURFACE-LESS (30.8): the byo escape-hatch app (wpgraphql, zero surfaces[]) still groups by id", () => {
    const groups = groupByApp({
      platforms: [{ id: "wpgraphql", kind: "graphql", displayName: "WPGraphQL" }],
      credentials: [{ platformId: "wpgraphql", account: "default" }],
    })
    const group = groups.find((g) => g.appId === "wpgraphql")
    expect(group).toBeDefined()
    expect(group?.connections).toHaveLength(1)
  })

  it("does NOT emit a catalog app with zero connections", () => {
    const groups = groupByApp({
      platforms: [{ id: "totally-unrelated", kind: "cli", displayName: "Totally Unrelated" }],
      credentials: [{ platformId: "totally-unrelated", account: "default" }],
    })
    // "notion" is a real catalog app but has no connection in this input —
    // it must not appear as an emitted group here (the /app index left-joins
    // listApps() separately for browsable-but-unconnected apps).
    expect(groups.find((g) => g.appId === "notion")).toBeUndefined()
  })
})
