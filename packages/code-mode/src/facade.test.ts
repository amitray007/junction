// SPDX-License-Identifier: AGPL-3.0-only
import type { ProviderTool } from "@junction/core"
import { describe, expect, it } from "vitest"
import { buildFacadePlan, describeFacadeTool, searchFacade } from "./facade.js"

const TOOLS: ProviderTool[] = [
  {
    name: "github__search_repos",
    description: "Search repositories",
    inputSchema: { type: "object" },
  },
  { name: "github__get_repo", description: "Fetch a single repo", inputSchema: { type: "object" } },
  {
    name: "slack__post_message",
    description: "Post a Slack message",
    inputSchema: { type: "object" },
  },
]

describe("buildFacadePlan", () => {
  it("groups tools by namespace", () => {
    const plan = buildFacadePlan(TOOLS, false)
    expect([...plan.byNamespace.keys()].sort()).toEqual(["github", "slack"])
    expect(plan.byNamespace.get("github")?.size).toBe(2)
    expect(plan.byNamespace.get("slack")?.size).toBe(1)
  })

  it("keeps the wire name for each entry (unprefixed arity)", () => {
    const plan = buildFacadePlan(TOOLS, false)
    const entry = plan.byNamespace.get("github")?.get("search_repos")
    expect(entry?.wireName).toBe("github__search_repos")
    expect(entry?.tool).toBe("search_repos")
    expect(entry?.namespace).toBe("github")
  })

  it("peels the profile prefix for prefixed (multi-profile) arity", () => {
    const prefixed: ProviderTool[] = [
      { name: "acme__github__search_repos", description: "d", inputSchema: {} },
    ]
    const plan = buildFacadePlan(prefixed, true)
    const entry = plan.byNamespace.get("github")?.get("search_repos")
    expect(entry?.wireName).toBe("acme__github__search_repos")
    expect(entry?.namespace).toBe("github")
    expect(entry?.tool).toBe("search_repos")
  })

  it("skips a malformed name defensively rather than throwing", () => {
    const malformed: ProviderTool[] = [
      { name: "noNamespaceSeparator", description: "d", inputSchema: {} },
    ]
    const plan = buildFacadePlan(malformed, false)
    expect(plan.flat).toHaveLength(0)
  })

  it("flat mirrors byNamespace", () => {
    const plan = buildFacadePlan(TOOLS, false)
    expect(plan.flat).toHaveLength(3)
  })
})

describe("searchFacade", () => {
  const plan = buildFacadePlan(TOOLS, false)

  it("matches by namespace substring", () => {
    const results = searchFacade(plan, "git")
    expect(results.map((r) => r.tool).sort()).toEqual(["get_repo", "search_repos"])
  })

  it("matches by tool name substring", () => {
    const results = searchFacade(plan, "post_message")
    expect(results).toHaveLength(1)
    expect(results[0]?.namespace).toBe("slack")
  })

  it("matches by description substring, case-insensitively", () => {
    const results = searchFacade(plan, "SLACK MESSAGE")
    expect(results).toHaveLength(1)
  })

  it("never re-derives description text beyond what the plan already carries", () => {
    const results = searchFacade(plan, "repo")
    for (const r of results) {
      const original = TOOLS.find((t) => t.name === `${r.namespace}__${r.tool}`)
      expect(r.description).toBe(original?.description)
    }
  })

  it("returns empty for no match", () => {
    expect(searchFacade(plan, "nonexistent-xyz")).toHaveLength(0)
  })
})

describe("describeFacadeTool", () => {
  const plan = buildFacadePlan(TOOLS, false)

  it("resolves a namespace.tool path", () => {
    const found = describeFacadeTool(plan, "github.search_repos")
    expect(found?.description).toBe("Search repositories")
    expect(found?.inputSchema).toEqual({ type: "object" })
  })

  it("returns undefined for an unknown path", () => {
    expect(describeFacadeTool(plan, "github.nonexistent")).toBeUndefined()
    expect(describeFacadeTool(plan, "nonexistent.tool")).toBeUndefined()
  })

  it("returns undefined for a malformed path (no dot)", () => {
    expect(describeFacadeTool(plan, "no-dot-here")).toBeUndefined()
  })
})
