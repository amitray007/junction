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
