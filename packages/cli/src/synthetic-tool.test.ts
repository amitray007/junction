// SPDX-License-Identifier: AGPL-3.0-only
// buildRunCodeHandlers / mergeHandlers tests — fake ProfileProxy, no QuickJS
// spin-up needed for the registration/arity/guard logic (the real
// runCode/QuickJsExecutor path is exercised end-to-end by code-mode's own
// test suite and by this increment's manual QA transcript — see
// docs/methods/33c-mcp-surface.md). This file proves:
//   (a) unprefixed registration: junction__run_code, single entry
//   (b) prefixed registration: <profile>__junction__run_code per entry
//   (c) reserved-namespace guard point 2: a legacy junction__* tool on a
//       profile's OWN filtered listTools() refuses that profile's synthetic
//       tool + fires the collision callback — other profiles unaffected
//   (d) mergeHandlers concatenates tool lists and routes callTool by name
//       without colliding with real namespaced tools

import type {
  AuditEntry,
  AuditPrincipal,
  ProfileProxy,
  ProviderTool,
  ToolResult,
} from "@junction/core"
import { okAsync } from "neverthrow"
import { describe, expect, it } from "vitest"
import { buildRunCodeHandlers, mergeHandlers, type RunCodeEntry } from "./synthetic-tool.js"

const PRINCIPAL: AuditPrincipal = { kind: "stdio", keyId: null, label: null, profiles: ["default"] }

/** Build a fake ProfileProxy serving the given already-namespaced tool names. */
function makeFakeProxy(toolNames: string[]): ProfileProxy {
  return {
    listTools() {
      return okAsync(toolNames.map((name) => ({ name, inputSchema: {} }) satisfies ProviderTool))
    },
    callTool() {
      return okAsync({ content: [{ type: "text", text: "{}" }] } satisfies ToolResult)
    },
  }
}

function makeSink(): { sink: { emit: (e: AuditEntry) => void }; entries: AuditEntry[] } {
  const entries: AuditEntry[] = []
  return { sink: { emit: (e) => entries.push(e) }, entries }
}

// ---------------------------------------------------------------------------
// (a) unprefixed registration
// ---------------------------------------------------------------------------

describe("buildRunCodeHandlers — prefixed:false (stdio / scope:'profile')", () => {
  it("registers a single unprefixed junction__run_code tool", async () => {
    const { sink } = makeSink()
    const entries: RunCodeEntry[] = [
      { profileName: "work", proxy: makeFakeProxy(["github__list_issues"]) },
    ]

    const handlers = await buildRunCodeHandlers({
      entries,
      prefixed: false,
      principal: PRINCIPAL,
      sink,
      onReservedNamespaceCollision: () => {
        throw new Error("should not fire — no collision")
      },
    })

    const { tools } = await handlers.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe("junction__run_code")
    expect(tools[0]?.description).toContain("tools.search")
    expect(tools[0]?.inputSchema).toMatchObject({
      type: "object",
      required: ["code"],
    })
  })
})

// ---------------------------------------------------------------------------
// (b) prefixed registration — arity mirrors createScopedProxy exactly
// ---------------------------------------------------------------------------

describe("buildRunCodeHandlers — prefixed:true (scope:'profiles'/'global')", () => {
  it("registers one <profile>__junction__run_code tool per routed profile", async () => {
    const { sink } = makeSink()
    const entries: RunCodeEntry[] = [
      { profileName: "work", proxy: makeFakeProxy(["github__list_issues"]) },
      { profileName: "personal", proxy: makeFakeProxy(["linear__get_issue"]) },
    ]

    const handlers = await buildRunCodeHandlers({
      entries,
      prefixed: true,
      principal: PRINCIPAL,
      sink,
      onReservedNamespaceCollision: () => {
        throw new Error("should not fire — no collision")
      },
    })

    const { tools } = await handlers.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["personal__junction__run_code", "work__junction__run_code"])
  })

  it("callTool routes by the arity-prefixed wire name to the correct profile's proxy", async () => {
    const { sink } = makeSink()
    let workCalled = false
    const workProxy = makeFakeProxy(["github__list_issues"])
    workProxy.callTool = () => {
      workCalled = true
      return okAsync({ content: [{ type: "text", text: "{}" }] } satisfies ToolResult)
    }
    const entries: RunCodeEntry[] = [
      { profileName: "work", proxy: workProxy },
      { profileName: "personal", proxy: makeFakeProxy([]) },
    ]

    const handlers = await buildRunCodeHandlers({
      entries,
      prefixed: true,
      principal: PRINCIPAL,
      sink,
      onReservedNamespaceCollision: () => {
        throw new Error("should not fire")
      },
    })

    const result = await handlers.callTool("work__junction__run_code", { code: "return 1" })
    expect(result.isError).toBeFalsy()
    // The engine actually running QuickJS proves workCalled would only flip if
    // guest code calls a facade tool — this snippet doesn't, so assert the
    // ROUTING (no error, no cross-profile leak) rather than workCalled here.
    expect(workCalled).toBe(false)
  })

  it("an unknown wire name (e.g. a non-existent profile prefix) returns tool-not-found", async () => {
    const { sink } = makeSink()
    const entries: RunCodeEntry[] = [{ profileName: "work", proxy: makeFakeProxy([]) }]
    const handlers = await buildRunCodeHandlers({
      entries,
      prefixed: true,
      principal: PRINCIPAL,
      sink,
      onReservedNamespaceCollision: () => {
        throw new Error("should not fire")
      },
    })
    const result = await handlers.callTool("nope__junction__run_code", { code: "1" })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("tool not found")
  })
})

// ---------------------------------------------------------------------------
// (c) reserved-namespace guard point 2 — legacy junction__* collision
// ---------------------------------------------------------------------------

describe("buildRunCodeHandlers — reserved-namespace guard point 2 (serve-time read-guard)", () => {
  it("refuses the synthetic tool for a profile whose OWN filtered tools already contain junction__*", async () => {
    const { sink } = makeSink()
    const collisions: string[] = []
    const entries: RunCodeEntry[] = [
      // Legacy source somehow namespaced "junction" pre-dates the schema reserve.
      { profileName: "legacy", proxy: makeFakeProxy(["junction__old_tool"]) },
      { profileName: "clean", proxy: makeFakeProxy(["github__list_issues"]) },
    ]

    const handlers = await buildRunCodeHandlers({
      entries,
      prefixed: true,
      principal: PRINCIPAL,
      sink,
      onReservedNamespaceCollision: (info) => collisions.push(info.profileName),
    })

    expect(collisions).toEqual(["legacy"])

    const { tools } = await handlers.listTools()
    const names = tools.map((t) => t.name)
    // Only the clean profile gets its synthetic tool — legacy is refused, not shadowed.
    expect(names).toEqual(["clean__junction__run_code"])
  })

  it("a call to a refused profile's wire name still returns tool-not-found (never silently shadows)", async () => {
    const { sink } = makeSink()
    const entries: RunCodeEntry[] = [
      { profileName: "legacy", proxy: makeFakeProxy(["junction__old_tool"]) },
    ]
    const handlers = await buildRunCodeHandlers({
      entries,
      prefixed: true,
      principal: PRINCIPAL,
      sink,
      onReservedNamespaceCollision: () => {},
    })
    const result = await handlers.callTool("legacy__junction__run_code", { code: "1" })
    expect(result.isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (d) mergeHandlers
// ---------------------------------------------------------------------------

describe("mergeHandlers", () => {
  it("concatenates real + synthetic tool lists", async () => {
    const real = {
      listTools: async () => ({ tools: [{ name: "github__list_issues", inputSchema: {} }] }),
      callTool: async (name: string) => ({
        content: [{ type: "text" as const, text: `real:${name}` }],
      }),
    }
    const { sink } = makeSink()
    const entries: RunCodeEntry[] = [{ profileName: "work", proxy: makeFakeProxy([]) }]
    const synthetic = await buildRunCodeHandlers({
      entries,
      prefixed: false,
      principal: PRINCIPAL,
      sink,
      onReservedNamespaceCollision: () => {},
    })

    const merged = mergeHandlers(real, synthetic)
    const { tools } = await merged.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["github__list_issues", "junction__run_code"])
  })

  it("routes junction__run_code to the synthetic handler and everything else to real", async () => {
    const calls: string[] = []
    const real = {
      listTools: async () => ({ tools: [] }),
      callTool: async (name: string) => {
        calls.push(`real:${name}`)
        return { content: [{ type: "text" as const, text: "ok" }] }
      },
    }
    const { sink } = makeSink()
    const entries: RunCodeEntry[] = [{ profileName: "work", proxy: makeFakeProxy([]) }]
    const synthetic = await buildRunCodeHandlers({
      entries,
      prefixed: false,
      principal: PRINCIPAL,
      sink,
      onReservedNamespaceCollision: () => {},
    })
    const merged = mergeHandlers(real, synthetic)

    await merged.callTool("github__list_issues", {})
    expect(calls).toEqual(["real:github__list_issues"])

    // junction__run_code goes to synthetic — never hits `real`. code:"" errors
    // out of code-mode fast (invalid-args-shaped), which is fine — we only
    // assert it did NOT fall through to `real`.
    calls.length = 0
    await merged.callTool("junction__run_code", { code: "1" })
    expect(calls).toEqual([])
  })
})
