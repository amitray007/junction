// SPDX-License-Identifier: AGPL-3.0-only
// createScopedProxy tests — fake ProfileProxy, no transport (increment 27 §2.4).
//
// Test surface:
//   (a) prefixed:false passthrough — single-profile, byte-identical names
//   (b) prefixed:true — 2-seg profile.listTools names get `<profileName>__` prepended
//   (c) callTool — splits on FIRST `__`, routes to the right profile, strips prefix
//   (d) hyphenated profile names still split correctly (profile names allow `-`)
//   (e) ≤64 guard: an over-long prefixed name is skipped in BOTH list and call
//   (f) unknown profile prefix on callTool → tool-not-found
//   (g) a failing per-profile listTools contributes nothing (does not abort others)

import { errAsync, okAsync } from "neverthrow"
import { describe, expect, it } from "vitest"
import type { UpstreamError } from "../errors/index.js"
import type { ProviderTool, ToolResult } from "./provider.js"
import type { ProfileProxy } from "./proxy.js"
import { createScopedProxy, type ScopedProxyEntry } from "./scoped-proxy.js"

/** Build a fake ProfileProxy that serves the given already-namespaced tool names. */
function makeFakeProfileProxy(
  toolNames: string[],
  callHandler?: (name: string, args: Record<string, unknown>) => unknown,
): { proxy: ProfileProxy; calls: string[] } {
  const calls: string[] = []
  const proxy: ProfileProxy = {
    listTools() {
      return okAsync(toolNames.map((name) => ({ name, inputSchema: {} }) satisfies ProviderTool))
    },
    callTool(name: string, args: Record<string, unknown>) {
      calls.push(name)
      const result = callHandler ? callHandler(name, args) : { echo: name }
      return okAsync({
        content: [{ type: "text", text: JSON.stringify(result) }],
      } satisfies ToolResult)
    },
  }
  return { proxy, calls }
}

function makeFailingProfileProxy(): ProfileProxy {
  return {
    listTools() {
      return errAsync({ kind: "connect-failed", cause: "boom" } satisfies UpstreamError)
    },
    callTool() {
      return errAsync({ kind: "connect-failed", cause: "boom" } satisfies UpstreamError)
    },
  }
}

// ---------------------------------------------------------------------------
// (a) prefixed:false passthrough
// ---------------------------------------------------------------------------

describe("createScopedProxy — prefixed:false (scope kind 'profile')", () => {
  it("passthrough: listTools returns byte-identical names to the single ProfileProxy", async () => {
    const { proxy } = makeFakeProfileProxy(["github_work__list_issues", "linear_work__get_issue"])
    const entries: ScopedProxyEntry[] = [{ profileName: "work", proxy }]

    const scoped = createScopedProxy(entries, false)
    const result = await scoped.listTools()
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.map((t) => t.name)).toEqual([
        "github_work__list_issues",
        "linear_work__get_issue",
      ])
    }
  })

  it("passthrough: callTool delegates the UNMODIFIED name to the single ProfileProxy", async () => {
    const { proxy, calls } = makeFakeProfileProxy(["github_work__list_issues"])
    const entries: ScopedProxyEntry[] = [{ profileName: "work", proxy }]

    const scoped = createScopedProxy(entries, false)
    const result = await scoped.callTool("github_work__list_issues", {})
    expect(result.isOk()).toBe(true)
    expect(calls).toEqual(["github_work__list_issues"])
  })
})

// ---------------------------------------------------------------------------
// (b)+(c) prefixed:true — multi-profile prefixing + routing
// ---------------------------------------------------------------------------

describe("createScopedProxy — prefixed:true (scope kind 'profiles'/'global')", () => {
  it("prepends <profileName>__ to every tool name across all entries", async () => {
    const { proxy: workProxy } = makeFakeProfileProxy(["github_work__list_issues"])
    const { proxy: personalProxy } = makeFakeProfileProxy(["linear_personal__get_issue"])
    const entries: ScopedProxyEntry[] = [
      { profileName: "work", proxy: workProxy },
      { profileName: "personal", proxy: personalProxy },
    ]

    const scoped = createScopedProxy(entries, true)
    const result = await scoped.listTools()
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      const names = result.value.map((t) => t.name)
      expect(names).toContain("work__github_work__list_issues")
      expect(names).toContain("personal__linear_personal__get_issue")
    }
  })

  it("callTool splits on the FIRST __, routes to the right profile, and strips only the profile prefix", async () => {
    const { proxy: workProxy, calls: workCalls } = makeFakeProfileProxy([
      "github_work__list_issues",
    ])
    const { proxy: personalProxy, calls: personalCalls } = makeFakeProfileProxy([
      "linear_personal__get_issue",
    ])
    const entries: ScopedProxyEntry[] = [
      { profileName: "work", proxy: workProxy },
      { profileName: "personal", proxy: personalProxy },
    ]

    const scoped = createScopedProxy(entries, true)

    const result = await scoped.callTool("work__github_work__list_issues", { state: "open" })
    expect(result.isOk()).toBe(true)
    // The inner ProfileProxy receives the REMAINDER (namespace__tool), profile
    // prefix stripped — it does its own namespace split internally.
    expect(workCalls).toEqual(["github_work__list_issues"])
    expect(personalCalls).toEqual([])
  })

  it("hyphenated profile names split correctly (profile names allow '-', never '_')", async () => {
    const { proxy, calls } = makeFakeProfileProxy(["github_work__list_issues"])
    const entries: ScopedProxyEntry[] = [{ profileName: "client-acme", proxy }]

    const scoped = createScopedProxy(entries, true)

    const listResult = await scoped.listTools()
    expect(listResult.isOk()).toBe(true)
    if (listResult.isOk()) {
      expect(listResult.value.map((t) => t.name)).toEqual(["client-acme__github_work__list_issues"])
    }

    const callResult = await scoped.callTool("client-acme__github_work__list_issues", {})
    expect(callResult.isOk()).toBe(true)
    expect(calls).toEqual(["github_work__list_issues"])
  })

  it("unknown profile prefix on callTool → tool-not-found", async () => {
    const { proxy } = makeFakeProfileProxy(["github_work__list_issues"])
    const entries: ScopedProxyEntry[] = [{ profileName: "work", proxy }]
    const scoped = createScopedProxy(entries, true)

    const result = await scoped.callTool("nonexistent__github_work__list_issues", {})
    expect(result.isOk()).toBe(false)
    if (!result.isOk()) expect(result.error.kind).toBe("tool-not-found")
  })

  it("a name with no '__' separator on callTool → tool-not-found", async () => {
    const { proxy } = makeFakeProfileProxy(["github_work__list_issues"])
    const entries: ScopedProxyEntry[] = [{ profileName: "work", proxy }]
    const scoped = createScopedProxy(entries, true)

    const result = await scoped.callTool("nosep", {})
    expect(result.isOk()).toBe(false)
    if (!result.isOk()) expect(result.error.kind).toBe("tool-not-found")
  })

  it("a failing per-profile listTools contributes nothing but does not abort the others", async () => {
    const failingProxy = makeFailingProfileProxy()
    const { proxy: okProxy } = makeFakeProfileProxy(["linear_personal__get_issue"])
    const entries: ScopedProxyEntry[] = [
      { profileName: "broken", proxy: failingProxy },
      { profileName: "personal", proxy: okProxy },
    ]

    const scoped = createScopedProxy(entries, true)
    const result = await scoped.listTools()
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.map((t) => t.name)).toEqual(["personal__linear_personal__get_issue"])
    }
  })
})

// ---------------------------------------------------------------------------
// (e) ≤64 guard re-applied to the FINAL prefixed name, consistently list vs call
// ---------------------------------------------------------------------------

describe("createScopedProxy — ≤64 guard on the prefixed name", () => {
  it("an over-long prefixed name is skipped at listTools", async () => {
    // profileName(30) + '__' + innerName(40) = 72 > 64 → must be skipped.
    const longProfileName = "p".repeat(30)
    const innerName = `${"n".repeat(30)}__${"t".repeat(6)}` // 40 chars inner
    const { proxy } = makeFakeProfileProxy([innerName])
    const entries: ScopedProxyEntry[] = [{ profileName: longProfileName, proxy }]

    const scoped = createScopedProxy(entries, true)
    const result = await scoped.listTools()
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual([])
  })

  it("the same over-long prefixed name is rejected at callTool (list/call agreement)", async () => {
    const longProfileName = "p".repeat(30)
    const innerName = `${"n".repeat(30)}__${"t".repeat(6)}`
    const { proxy, calls } = makeFakeProfileProxy([innerName])
    const entries: ScopedProxyEntry[] = [{ profileName: longProfileName, proxy }]

    const scoped = createScopedProxy(entries, true)
    const fullName = `${longProfileName}__${innerName}`
    const result = await scoped.callTool(fullName, {})
    expect(result.isOk()).toBe(false)
    if (!result.isOk()) expect(result.error.kind).toBe("tool-not-found")
    // Must reject BEFORE delegating — no connection/call attempt made.
    expect(calls).toEqual([])
  })

  it("a name at exactly 64 chars is NOT skipped", async () => {
    // profileName(10) + '__' + innerName(52) = 64 exactly.
    const profileName = "p".repeat(10)
    const innerName = `${"n".repeat(48)}__tt` // 48 + 2 + 2 = 52 chars
    const { proxy } = makeFakeProfileProxy([innerName])
    const entries: ScopedProxyEntry[] = [{ profileName, proxy }]

    const scoped = createScopedProxy(entries, true)
    const result = await scoped.listTools()
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      const fullName = `${profileName}__${innerName}`
      expect(fullName.length).toBe(64)
      expect(result.value.map((t) => t.name)).toEqual([fullName])
    }
  })
})
