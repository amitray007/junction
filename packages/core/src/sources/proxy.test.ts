// SPDX-License-Identifier: AGPL-3.0-only
// createProfileProxy tests — fake ToolProvider, no transport or network.
//
// Tests use fake ToolProvider implementations instead of real MCP transports,
// making them faster and simpler. The behavior assertions are UNCHANGED from
// the original proxy tests — this is the moved + adapted suite (increment 14).
//
// Test surface:
//   (a) End-to-end proxy       — listTools + callTool through the proxy
//   (b) Multi-source           — two namespaces list and route correctly
//   (c) Per-source resilience  — one dead source does not kill the profile
//   (d) toolFilter (allow/deny)— only permitted upstream tools surface (list)
//   (d2) toolFilter on callTool— denied tools blocked even when called directly
//   (e) Sentinel credential    — secret never in proxy output (proxy never sees it)
//   (f) Disabled sources       — excluded from list and call
//   (g) Session close()        — close() called on every connected provider
//   (h) Enable/disable toggle  — disabled stops serving; re-enable restores it
//   (i) ≤64 guard              — tool whose namespaced name > 64 chars is skipped

import { errAsync, okAsync } from "neverthrow"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceRef, ToolFilter, UpstreamError } from "../index.js"
import { CredentialIdSchema, PlatformIdSchema } from "../index.js"
import type { ProviderTool, ToolProvider, ToolResult } from "./provider.js"
import type { ResolveProviderFn } from "./proxy.js"
import { createProfileProxy } from "./proxy.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal SourceRef for testing. */
function makeSourceRef(toolNamespace: string, toolFilter?: ToolFilter, enabled = true): SourceRef {
  return {
    platformId: PlatformIdSchema.parse("test-platform"),
    credentialId: CredentialIdSchema.parse("test-cred"),
    toolNamespace,
    enabled,
    toolFilter,
  }
}

/**
 * Build a fake ToolProvider that returns the given raw tool names and optionally
 * records call routing. Tracks close() calls.
 */
function makeFakeProvider(
  toolNames: string[],
  callHandler?: (rawName: string, args: Record<string, unknown>) => unknown,
): { provider: ToolProvider; closeCount: () => number } {
  let closed = 0
  const provider: ToolProvider = {
    listTools() {
      return okAsync(toolNames.map((name) => ({ name, inputSchema: {} }) satisfies ProviderTool))
    },
    callTool(rawName: string, args: Record<string, unknown>) {
      const result = callHandler ? callHandler(rawName, args) : { echo: rawName }
      return okAsync({
        content: [{ type: "text", text: JSON.stringify(result) }],
      } satisfies ToolResult)
    },
    async close(): Promise<void> {
      closed++
    },
  }
  return { provider, closeCount: () => closed }
}

/** Build a fake ToolProvider whose listTools always fails. */
function makeFailProvider(): ToolProvider {
  return {
    listTools() {
      return errAsync({ kind: "connect-failed", cause: "intentional fail" } satisfies UpstreamError)
    },
    callTool() {
      return errAsync({ kind: "connect-failed", cause: "intentional fail" } satisfies UpstreamError)
    },
    async close(): Promise<void> {},
  }
}

/** resolveProvider stub: always Ok with a given provider and namespace. */
function resolveOk(
  toolNamespace: string,
  provider: ToolProvider,
  toolFilter?: ToolFilter,
): ResolveProviderFn {
  return (_sr) => okAsync({ provider, toolNamespace, toolFilter })
}

/** resolveProvider stub: always Err. */
function resolveErr(): ResolveProviderFn {
  return () => errAsync({ kind: "connect-failed", cause: "resolve failed" } satisfies UpstreamError)
}

// ---------------------------------------------------------------------------
// (a) End-to-end proxy — listTools + callTool
// ---------------------------------------------------------------------------

describe("createProfileProxy — listTools", () => {
  it("returns namespaced tools for a single source", async () => {
    const { provider } = makeFakeProvider(["list_issues", "get_pull_request"])

    const proxy = createProfileProxy([makeSourceRef("src")], resolveOk("src", provider))

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap().map((t) => t.name)).toEqual([
      "src__list_issues",
      "src__get_pull_request",
    ])
  })
})

describe("createProfileProxy — callTool", () => {
  it("routes the call to the upstream with the raw name and returns its result", async () => {
    const calls: string[] = []
    const { provider } = makeFakeProvider(["list_issues"], (rawName) => {
      calls.push(rawName)
      return { routed: rawName }
    })

    const proxy = createProfileProxy([makeSourceRef("src")], resolveOk("src", provider))

    const result = await proxy.callTool("src__list_issues", { state: "open" })
    expect(result.isOk()).toBe(true)
    // The provider received the STRIPPED (raw) name
    expect(calls).toEqual(["list_issues"])
  })
})

// ---------------------------------------------------------------------------
// (b) Multi-source namespacing
// ---------------------------------------------------------------------------

describe("createProfileProxy — multi-source", () => {
  it("lists tools from both sources under their namespaces", async () => {
    const { provider: workProvider } = makeFakeProvider(["list_projects"])
    const { provider: personalProvider } = makeFakeProvider(["list_notes"])

    const sources = [makeSourceRef("work"), makeSourceRef("personal")]
    const proxy = createProfileProxy(sources, (sr) =>
      okAsync({
        provider: sr.toolNamespace === "work" ? workProvider : personalProvider,
        toolNamespace: sr.toolNamespace,
      }),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toContain("work__list_projects")
    expect(names).toContain("personal__list_notes")
  })

  it("routes callTool to the correct source by namespace", async () => {
    const workCalls: string[] = []
    const personalCalls: string[] = []

    const { provider: workProvider } = makeFakeProvider(["list_projects"], (n) => {
      workCalls.push(n)
      return { from: "work" }
    })
    const { provider: personalProvider } = makeFakeProvider(["list_notes"], (n) => {
      personalCalls.push(n)
      return { from: "personal" }
    })

    const sources = [makeSourceRef("work"), makeSourceRef("personal")]
    const proxy = createProfileProxy(sources, (sr) =>
      okAsync({
        provider: sr.toolNamespace === "work" ? workProvider : personalProvider,
        toolNamespace: sr.toolNamespace,
      }),
    )

    await proxy.callTool("work__list_projects", {})
    await proxy.callTool("personal__list_notes", {})

    expect(workCalls).toEqual(["list_projects"])
    expect(personalCalls).toEqual(["list_notes"])
  })
})

// ---------------------------------------------------------------------------
// (c) Per-source resilience
// ---------------------------------------------------------------------------

describe("createProfileProxy — per-source resilience", () => {
  it("a source that fails resolveProvider is skipped; the rest still list", async () => {
    const { provider: goodProvider } = makeFakeProvider(["tool_a"])
    const sources = [makeSourceRef("bad"), makeSourceRef("good")]

    const proxy = createProfileProxy(sources, (sr) =>
      sr.toolNamespace === "bad" ? resolveErr()(sr) : resolveOk(sr.toolNamespace, goodProvider)(sr),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toEqual(["good__tool_a"])
  })

  it("a source that fails listTools is skipped; the rest still list", async () => {
    const { provider: goodProvider } = makeFakeProvider(["tool_a"])
    const badProvider = makeFailProvider()

    const sources = [makeSourceRef("bad"), makeSourceRef("good")]
    const proxy = createProfileProxy(sources, (sr) =>
      okAsync({
        provider: sr.toolNamespace === "bad" ? badProvider : goodProvider,
        toolNamespace: sr.toolNamespace,
      }),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap().map((t) => t.name)).toEqual(["good__tool_a"])
  })

  it("callTool to a source that fails resolveProvider returns Err", async () => {
    const sources = [makeSourceRef("src")]
    const proxy = createProfileProxy(sources, resolveErr())

    const result = await proxy.callTool("src__some_tool", {})
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().kind).toBe("connect-failed")
  })

  it("callTool to a completely unknown namespace returns tool-not-found", async () => {
    const { provider } = makeFakeProvider(["tool_a"])
    const sources = [makeSourceRef("src")]
    const proxy = createProfileProxy(sources, resolveOk("src", provider))

    const result = await proxy.callTool("unknown__tool", {})
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().kind).toBe("tool-not-found")
  })
})

// ---------------------------------------------------------------------------
// (d) toolFilter — list path
// ---------------------------------------------------------------------------

describe("createProfileProxy — toolFilter", () => {
  it("allow list: only permitted upstream tool names surface", async () => {
    const { provider } = makeFakeProvider(["list_issues", "get_pull_request", "delete_repo"])

    const filter: ToolFilter = { allow: ["list_issues", "get_pull_request"] }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", provider, filter),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toContain("src__list_issues")
    expect(names).toContain("src__get_pull_request")
    expect(names).not.toContain("src__delete_repo")
  })

  it("deny list: denied upstream tools are excluded", async () => {
    const { provider } = makeFakeProvider(["list_issues", "delete_repo"])

    const filter: ToolFilter = { deny: ["delete_repo"] }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", provider, filter),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toContain("src__list_issues")
    expect(names).not.toContain("src__delete_repo")
  })

  it("allow + deny: allow first, then deny removes the overlap", async () => {
    const { provider } = makeFakeProvider(["list_issues", "get_issue", "delete_issue"])

    const filter: ToolFilter = {
      allow: ["list_issues", "get_issue", "delete_issue"],
      deny: ["delete_issue"],
    }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", provider, filter),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toEqual(["src__list_issues", "src__get_issue"])
  })

  it("allow: [] (empty allow list) hides ALL tools from listTools", async () => {
    const { provider } = makeFakeProvider(["list_issues", "get_issue"])

    const filter: ToolFilter = { allow: [] }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", provider, filter),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (d2) toolFilter enforcement on callTool
// ---------------------------------------------------------------------------

describe("createProfileProxy — toolFilter enforced on callTool", () => {
  it("deny filter: denied tool returns tool-not-found even when called directly", async () => {
    const { provider } = makeFakeProvider(["list_issues", "delete_repo"])

    const filter: ToolFilter = { deny: ["delete_repo"] }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", provider, filter),
    )

    // Agent bypasses listTools and tries to call the denied tool directly — must be blocked.
    const result = await proxy.callTool("src__delete_repo", {})
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().kind).toBe("tool-not-found")
  })

  it("allow filter: tool not in the allow list returns tool-not-found from callTool", async () => {
    const { provider } = makeFakeProvider(["list_issues", "delete_repo"])

    const filter: ToolFilter = { allow: ["list_issues"] }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", provider, filter),
    )

    // "delete_repo" is not in the allow list — must be blocked at callTool.
    const result = await proxy.callTool("src__delete_repo", {})
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().kind).toBe("tool-not-found")
  })

  it("allowed tool still routes to upstream via callTool", async () => {
    const calls: string[] = []
    const { provider } = makeFakeProvider(["list_issues"], (rawName) => {
      calls.push(rawName)
      return { result: "ok" }
    })

    const filter: ToolFilter = { allow: ["list_issues"] }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", provider, filter),
    )

    const result = await proxy.callTool("src__list_issues", {})
    expect(result.isOk()).toBe(true)
    expect(calls).toEqual(["list_issues"])
  })

  it("allow: [] (empty allow list) blocks callTool for any tool", async () => {
    const { provider } = makeFakeProvider(["list_issues"])

    const filter: ToolFilter = { allow: [] }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", provider, filter),
    )

    const result = await proxy.callTool("src__list_issues", {})
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().kind).toBe("tool-not-found")
  })
})

// ---------------------------------------------------------------------------
// (g) Provider close() discipline
// ---------------------------------------------------------------------------

describe("createProfileProxy — provider close() discipline", () => {
  /**
   * Build a resolveProvider that wraps providers with a close() spy.
   * closeCounts maps toolNamespace → number of times close() was called.
   */
  function makeSpyResolve(
    providerMap: Map<string, ToolProvider>,
    closeCounts: Map<string, number>,
  ): ResolveProviderFn {
    return (sourceRef) => {
      const provider = providerMap.get(sourceRef.toolNamespace)
      if (provider === undefined) {
        return errAsync({
          kind: "connect-failed",
          cause: "no provider for namespace",
        } satisfies UpstreamError)
      }
      const wrapped: ToolProvider = {
        listTools: () => provider.listTools(),
        callTool: (n, a) => provider.callTool(n, a),
        close: async () => {
          closeCounts.set(
            sourceRef.toolNamespace,
            (closeCounts.get(sourceRef.toolNamespace) ?? 0) + 1,
          )
          await provider.close()
        },
      }
      return okAsync({ provider: wrapped, toolNamespace: sourceRef.toolNamespace })
    }
  }

  it("close() called exactly once per connected provider on listTools success", async () => {
    const { provider: p1 } = makeFakeProvider(["tool_a"])
    const { provider: p2 } = makeFakeProvider(["tool_b"])
    const closeCounts = new Map<string, number>()
    const providerMap = new Map([
      ["ns1", p1],
      ["ns2", p2],
    ])

    const proxy = createProfileProxy(
      [makeSourceRef("ns1"), makeSourceRef("ns2")],
      makeSpyResolve(providerMap, closeCounts),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    expect(closeCounts.get("ns1")).toBe(1)
    expect(closeCounts.get("ns2")).toBe(1)
  })

  it("later source still lists and closes when a mid-list source fails to resolve", async () => {
    const { provider: good } = makeFakeProvider(["tool_a"])
    const closeCounts = new Map<string, number>()
    // "bad" not in providerMap → resolve returns Err → never gets a provider → close never called
    const providerMap = new Map([["good", good]])

    const proxy = createProfileProxy(
      [makeSourceRef("bad"), makeSourceRef("good")],
      makeSpyResolve(providerMap, closeCounts),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap().map((t) => t.name)).toEqual(["good__tool_a"])
    // good was connected — its provider must be closed exactly once
    expect(closeCounts.get("good")).toBe(1)
    // bad never connected — no close call expected
    expect(closeCounts.get("bad")).toBeUndefined()
  })

  it("callTool: provider close() is called even when the call returns an error", async () => {
    // Provider whose callTool returns an Err
    let closed = 0
    const provider: ToolProvider = {
      listTools() {
        return okAsync([{ name: "tool_a", inputSchema: {} }])
      },
      callTool() {
        return errAsync({ kind: "call-failed", cause: "boom" } satisfies UpstreamError)
      },
      async close() {
        closed++
      },
    }
    const sources = [makeSourceRef("src")]
    const proxy = createProfileProxy(sources, resolveOk("src", provider))

    await proxy.callTool("src__tool_a", {})
    expect(closed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// (e) Sentinel credential discipline
// ---------------------------------------------------------------------------

describe("createProfileProxy — sentinel credential discipline", () => {
  const SENTINEL = "SUPER_SECRET_SENTINEL_TOKEN_XYZ_9876"

  it("sentinel secret does not appear in listTools result", async () => {
    // In the new design the proxy receives { provider, toolNamespace, toolFilter } — NO secret.
    // This test guards the invariant: the proxy cannot leak a secret it never receives.
    const { provider } = makeFakeProvider(["tool_a"])
    const proxy = createProfileProxy([makeSourceRef("src")], (_) =>
      okAsync({ provider, toolNamespace: "src" }),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)

    const serialized = JSON.stringify(result._unsafeUnwrap())
    expect(serialized).not.toContain(SENTINEL)
  })

  it("sentinel secret does not appear in callTool result", async () => {
    const { provider } = makeFakeProvider(["greet"], () => ({ message: "hello" }))
    const proxy = createProfileProxy([makeSourceRef("src")], (_) =>
      okAsync({ provider, toolNamespace: "src" }),
    )

    const result = await proxy.callTool("src__greet", {})
    expect(result.isOk()).toBe(true)

    const serialized = JSON.stringify(result._unsafeUnwrap())
    expect(serialized).not.toContain(SENTINEL)
  })

  it("sentinel secret does not appear in error results", async () => {
    // callTool on a non-existent namespace → tool-not-found error
    const { provider } = makeFakeProvider(["tool_a"])
    const proxy = createProfileProxy([makeSourceRef("src")], (_) =>
      okAsync({ provider, toolNamespace: "src" }),
    )

    const result = await proxy.callTool("other__greet", {})
    expect(result.isErr()).toBe(true)

    const serialized = JSON.stringify(result._unsafeUnwrapErr())
    expect(serialized).not.toContain(SENTINEL)
  })
})

// ---------------------------------------------------------------------------
// (f) Disabled sources are excluded
// ---------------------------------------------------------------------------

describe("createProfileProxy — disabled sources", () => {
  it("disabled sources are not listed or routed", async () => {
    const { provider } = makeFakeProvider(["tool_a"])

    const sources = [makeSourceRef("src", undefined, false)] // disabled
    const proxy = createProfileProxy(sources, resolveOk("src", provider))

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toHaveLength(0)

    const callResult = await proxy.callTool("src__tool_a", {})
    expect(callResult.isErr()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (h) Enable/disable toggle end-to-end
// ---------------------------------------------------------------------------

describe("createProfileProxy — enable/disable toggle end-to-end", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const c of cleanups) c()
    cleanups.length = 0
  })

  it("disabling a source stops it from being served; re-enabling restores it", async () => {
    const { provider } = makeFakeProvider(["get_thing", "list_things"])

    // Start with source enabled
    const proxyEnabled = createProfileProxy(
      [makeSourceRef("demo", undefined, true)],
      resolveOk("demo", provider),
    )

    const enabledResult = await proxyEnabled.listTools()
    expect(enabledResult.isOk()).toBe(true)
    const enabledTools = enabledResult._unsafeUnwrap().map((t) => t.name)
    expect(enabledTools).toContain("demo__get_thing")
    expect(enabledTools).toContain("demo__list_things")

    // Simulate disable-source
    const proxyDisabled = createProfileProxy(
      [makeSourceRef("demo", undefined, false)],
      resolveOk("demo", provider),
    )

    const disabledResult = await proxyDisabled.listTools()
    expect(disabledResult.isOk()).toBe(true)
    expect(disabledResult._unsafeUnwrap()).toHaveLength(0)

    const callResult = await proxyDisabled.callTool("demo__get_thing", {})
    expect(callResult.isErr()).toBe(true)
    expect(callResult._unsafeUnwrapErr().kind).toBe("tool-not-found")

    // Re-enable
    const { provider: provider2 } = makeFakeProvider(["get_thing", "list_things"])
    const proxyReEnabled = createProfileProxy(
      [makeSourceRef("demo", undefined, true)],
      resolveOk("demo", provider2),
    )
    const reEnabledResult = await proxyReEnabled.listTools()
    expect(reEnabledResult.isOk()).toBe(true)
    const reEnabledTools = reEnabledResult._unsafeUnwrap().map((t) => t.name)
    expect(reEnabledTools).toContain("demo__get_thing")
    expect(reEnabledTools).toContain("demo__list_things")
  })
})

// ---------------------------------------------------------------------------
// (i) ≤64 guard — proxy applies namespaceToolName and skips over-long tools
// ---------------------------------------------------------------------------

describe("createProfileProxy — ≤64 guard", () => {
  it("tools whose namespaced name would exceed 64 chars are silently skipped", async () => {
    // "ns__" + 61 chars = 65 > 64 → skipped
    const longTool = "b".repeat(61)
    const { provider } = makeFakeProvider(["ok_tool", longTool])

    const proxy = createProfileProxy([makeSourceRef("ns")], resolveOk("ns", provider))

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toEqual(["ns__ok_tool"])
    expect(names).not.toContain(`ns__${longTool}`)
  })

  it("accepts exactly 64-char namespaced names", async () => {
    // 10 + 2 + 52 = 64 — at the boundary
    const ns = "a".repeat(10)
    const toolName = "b".repeat(52)
    const { provider } = makeFakeProvider([toolName])

    const proxy = createProfileProxy([makeSourceRef(ns)], resolveOk(ns, provider))

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toHaveLength(1)
    expect(names[0]).toHaveLength(64)
  })

  it("tools with MCP-illegal characters in raw name are silently skipped", async () => {
    const { provider } = makeFakeProvider(["good_tool", "bad name"])

    const proxy = createProfileProxy([makeSourceRef("ns")], resolveOk("ns", provider))

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toEqual(["ns__good_tool"])
  })
})
