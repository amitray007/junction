// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AuditEntry,
  AuditPrincipal,
  AuditSink,
  ProviderTool,
  ToolResult,
  UpstreamError,
} from "@junction/core"
import { err, ok, type Result } from "neverthrow"
import { describe, expect, it } from "vitest"
import { createAuditedInvoker, type ProxyLike } from "./audited-invoker.js"

const PRINCIPAL: AuditPrincipal = { kind: "stdio", keyId: null, label: null, profiles: ["default"] }

function makeSink(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = []
  return { sink: { emit: (e) => entries.push(e) }, entries }
}

function okProxy(tools: ProviderTool[]): ProxyLike {
  return {
    listTools: async (): Promise<Result<ProviderTool[], UpstreamError>> => ok(tools),
    callTool: async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Result<ToolResult, UpstreamError>> => ok({ content: { echo: { name, args } } }),
  }
}

describe("createAuditedInvoker", () => {
  it("passes through listTools results", async () => {
    const tools: ProviderTool[] = [{ name: "gh__search", description: "d", inputSchema: {} }]
    const invoker = createAuditedInvoker({
      proxy: okProxy(tools),
      sink: makeSink().sink,
      principal: PRINCIPAL,
      profile: "default",
      correlationId: "c1",
    })
    await expect(invoker.listTools()).resolves.toEqual(tools)
  })

  it("degrades to an empty list (never throws) when the proxy's listTools errors", async () => {
    const proxy: ProxyLike = {
      listTools: async () => err({ kind: "connect-failed", cause: "boom" }),
      callTool: async () => ok({ content: null }),
    }
    const invoker = createAuditedInvoker({
      proxy,
      sink: makeSink().sink,
      principal: PRINCIPAL,
      profile: "default",
      correlationId: "c1",
    })
    await expect(invoker.listTools()).resolves.toEqual([])
  })

  it("emits ONE tool_call audit line per callTool, with the correlationId shared across calls", async () => {
    const { sink, entries } = makeSink()
    const invoker = createAuditedInvoker({
      proxy: okProxy([]),
      sink,
      principal: PRINCIPAL,
      profile: "default",
      correlationId: "shared-correlation-id",
    })

    await invoker.callTool("gh__search", { q: "1" })
    await invoker.callTool("gh__search", { q: "2" })

    expect(entries).toHaveLength(2)
    for (const e of entries) {
      expect(e.event).toBe("tool_call")
      expect(e.correlationId).toBe("shared-correlation-id")
    }
  })

  it("tracks toolCallCount across calls (ok and error both count)", async () => {
    const proxy: ProxyLike = {
      listTools: async () => ok([]),
      callTool: async (name) =>
        name === "fails" ? err({ kind: "call-failed", cause: "x" }) : ok({ content: null }),
    }
    const invoker = createAuditedInvoker({
      proxy,
      sink: makeSink().sink,
      principal: PRINCIPAL,
      profile: "default",
      correlationId: "c1",
    })
    expect(invoker.toolCallCount).toBe(0)
    await invoker.callTool("ok1", {})
    expect(invoker.toolCallCount).toBe(1)
    await invoker.callTool("fails", {})
    expect(invoker.toolCallCount).toBe(2)
  })

  it("splits the wire name into namespace/tool for the audit target", async () => {
    const { sink, entries } = makeSink()
    const invoker = createAuditedInvoker({
      proxy: okProxy([]),
      sink,
      principal: PRINCIPAL,
      profile: "acme",
      correlationId: "c1",
    })
    await invoker.callTool("github__search_repos", {})
    const entry = entries[0]
    expect(entry?.event).toBe("tool_call")
    if (entry?.event === "tool_call") {
      expect(entry.target).toEqual({ profile: "acme", namespace: "github", tool: "search_repos" })
    }
  })

  it("propagates the TYPED Err untouched (no message mapping at this layer)", async () => {
    const upstreamError: UpstreamError = { kind: "call-failed", cause: { secret: "sk_live_xxx" } }
    const proxy: ProxyLike = {
      listTools: async () => ok([]),
      callTool: async () => err(upstreamError),
    }
    const invoker = createAuditedInvoker({
      proxy,
      sink: makeSink().sink,
      principal: PRINCIPAL,
      profile: "default",
      correlationId: "c1",
    })
    const result = await invoker.callTool("gh__search", {})
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual(upstreamError)
    }
  })

  it("NEVER logs an arg value in the audit line, only argKeys/argHash", async () => {
    const { sink, entries } = makeSink()
    const invoker = createAuditedInvoker({
      proxy: okProxy([]),
      sink,
      principal: PRINCIPAL,
      profile: "default",
      correlationId: "c1",
    })
    await invoker.callTool("gh__search", { secretQuery: "sk_live_PLANTED_SECRET" })
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain("sk_live_PLANTED_SECRET")
    const entry = entries[0]
    if (entry?.event === "tool_call") {
      expect(entry.argKeys).toEqual(["secretQuery"])
    }
  })

  it("marks outcome error and sets errorKind to the discriminated tag on an Err", async () => {
    const { sink, entries } = makeSink()
    const proxy: ProxyLike = {
      listTools: async () => ok([]),
      callTool: async () => err({ kind: "timed-out", ms: 5000 }),
    }
    const invoker = createAuditedInvoker({
      proxy,
      sink,
      principal: PRINCIPAL,
      profile: "default",
      correlationId: "c1",
    })
    await invoker.callTool("gh__search", {})
    const entry = entries[0]
    if (entry?.event === "tool_call") {
      expect(entry.outcome).toBe("error")
      expect(entry.errorKind).toBe("timed-out")
    }
  })
})
