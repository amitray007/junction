// SPDX-License-Identifier: AGPL-3.0-only
// McpToolProvider adapter tests + behavior-identical guard (increment 14).
//
// Test surface:
//   (a) McpToolProvider adapter — lists RAW names, callTool calls raw upstream, close closes
//   (b) Behavior-identical guard — in-memory MCP server → McpToolProvider via createSession
//       → core createProfileProxy → asserts the SAME namespaced list + routed call result
//       that the old proxy produced. Proves the split (raw provider + core proxy) is equivalent.

import type { SourceRef, ToolFilter } from "@junction/core"
import { CredentialIdSchema, createProfileProxy, PlatformIdSchema } from "@junction/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { okAsync } from "neverthrow"
import { afterEach, describe, expect, it } from "vitest"
import type { UpstreamSession } from "./session.js"
import { createSession, RESPONSE_BYTE_CAP } from "./session.js"

// ---------------------------------------------------------------------------
// Helper: stand up an in-memory MCP server and return a connected session
// ---------------------------------------------------------------------------

async function makeInMemorySession(
  tools: Array<{ name: string; description?: string }>,
  callHandler?: (name: string, args: Record<string, unknown>) => unknown,
): Promise<{ session: UpstreamSession; close: () => Promise<void> }> {
  const server = new Server(
    { name: "in-memory-upstream", version: "0.0.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: { type: "object" as const, properties: {} },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const result = callHandler
      ? callHandler(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
      : { echo: req.params.name }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
  })

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  // createSession now takes no toolNamespace — returns raw names
  const session = createSession(client, () => client.close())
  return { session, close: () => client.close() }
}

function makeSourceRef(toolNamespace: string, toolFilter?: ToolFilter, enabled = true): SourceRef {
  return {
    platformId: PlatformIdSchema.parse("test-platform"),
    credentialId: CredentialIdSchema.parse("test-cred"),
    toolNamespace,
    enabled,
    toolFilter,
  }
}

// ---------------------------------------------------------------------------
// (a) McpToolProvider adapter — raw names, raw callTool, close
// ---------------------------------------------------------------------------

describe("McpToolProvider adapter (via createSession) — raw names", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups) await c()
    cleanups.length = 0
  })

  it("listTools returns raw upstream names (no namespace prefix)", async () => {
    const { session, close } = await makeInMemorySession([
      { name: "list_issues" },
      { name: "get_pull_request" },
    ])
    cleanups.push(close)

    const result = await session.listTools()
    expect(result.isOk()).toBe(true)
    const tools = result._unsafeUnwrap()
    // RAW names — no namespace prefix
    expect(tools.map((t) => t.name)).toEqual(["list_issues", "get_pull_request"])
  })

  it("listTools returns camelCase and hyphenated names as-is (raw)", async () => {
    const { session, close } = await makeInMemorySession([
      { name: "printEnv" },
      { name: "get-thing" },
      { name: "list_issues" },
    ])
    cleanups.push(close)

    const result = await session.listTools()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap().map((t) => t.name)).toEqual([
      "printEnv",
      "get-thing",
      "list_issues",
    ])
  })

  it("listTools returns ALL raw tools including long-named ones (≤64 guard is in proxy)", async () => {
    // The ≤64 guard has moved to core/proxy — session returns everything raw
    const longTool = "b".repeat(61)
    const { session, close } = await makeInMemorySession([{ name: "ok_tool" }, { name: longTool }])
    cleanups.push(close)

    const result = await session.listTools()
    expect(result.isOk()).toBe(true)
    const tools = result._unsafeUnwrap()
    // Session returns both — the proxy will skip the long one during namespacing
    expect(tools.map((t) => t.name)).toEqual(["ok_tool", longTool])
  })

  it("callTool sends the raw name to upstream (no split/strip)", async () => {
    const calls: string[] = []
    const { session, close } = await makeInMemorySession([{ name: "list_issues" }], (name) => {
      calls.push(name)
      return { routed: name }
    })
    cleanups.push(close)

    // Proxy strips the namespace and passes the raw name; session just calls it
    const result = await session.callTool("list_issues", { state: "open" })
    expect(result.isOk()).toBe(true)
    // Upstream received the raw name directly
    expect(calls).toEqual(["list_issues"])
  })

  it("close() closes the underlying client connection", async () => {
    const { session } = await makeInMemorySession([{ name: "tool_a" }])

    // Just verify close() resolves without throwing
    await expect(session.close()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// (c) Response byte cap (32.13 Slice C) — a hostile/compromised MCP source
// returning an over-cap content blob must be rejected with response-too-large,
// not buffered through to the caller.
// ---------------------------------------------------------------------------

/** Like makeInMemorySession, but the call handler controls the RAW content array
 *  returned by callTool directly (no JSON.stringify wrapping) — needed to hand
 *  back an oversized text blob for the byte-cap test. */
async function makeInMemorySessionWithRawContent(
  tools: Array<{ name: string }>,
  content: Array<{ type: "text"; text: string }>,
): Promise<{ session: UpstreamSession; close: () => Promise<void> }> {
  const server = new Server(
    { name: "in-memory-upstream-raw", version: "0.0.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: "",
      inputSchema: { type: "object" as const, properties: {} },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, () => ({ content }))

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const session = createSession(client, () => client.close())
  return { session, close: () => client.close() }
}

describe("response byte cap (32.13 Slice C)", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups) await c()
    cleanups.length = 0
  })

  it("callTool rejects an over-cap content blob with response-too-large, not a buffered pass-through", async () => {
    // One text block comfortably over RESPONSE_BYTE_CAP (1 MB).
    const oversized = "x".repeat(RESPONSE_BYTE_CAP + 1024)
    const { session, close } = await makeInMemorySessionWithRawContent(
      [{ name: "big_tool" }],
      [{ type: "text", text: oversized }],
    )
    cleanups.push(close)

    const result = await session.callTool("big_tool", {})
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("response-too-large")
      if (result.error.kind === "response-too-large") {
        expect(result.error.limit).toBe(RESPONSE_BYTE_CAP)
      }
    }
  })

  it("callTool passes through a comfortably UNDER-cap content blob unchanged", async () => {
    const small = "small payload"
    const { session, close } = await makeInMemorySessionWithRawContent(
      [{ name: "small_tool" }],
      [{ type: "text", text: small }],
    )
    cleanups.push(close)

    const result = await session.callTool("small_tool", {})
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(JSON.stringify(result.value.content)).toContain(small)
    }
  })
})

// ---------------------------------------------------------------------------
// (b) Behavior-identical guard
//     in-memory MCP server → createSession (ToolProvider) → createProfileProxy
//     → same namespaced output as the OLD proxy produced
// ---------------------------------------------------------------------------

describe("behavior-identical guard — McpToolProvider + createProfileProxy", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups) await c()
    cleanups.length = 0
  })

  it("same namespaced tool list as old proxy (camelCase + hyphen tools)", async () => {
    // Two tools that exercise the MCP charset: camelCase + hyphen
    const { session, close } = await makeInMemorySession([
      { name: "printEnv" },
      { name: "get-thing" },
    ])
    cleanups.push(close)

    // Wrap session as a ToolProvider (same as what createMcpProvider returns)
    const provider = {
      listTools: () => session.listTools(),
      callTool: (rawName: string, args: Record<string, unknown>) => session.callTool(rawName, args),
      close: () => session.close(),
    }

    const proxy = createProfileProxy([makeSourceRef("ns")], (_sr) =>
      okAsync({ provider, toolNamespace: "ns" }),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)

    // Must match what the old proxy returned: <namespace>__<rawName>
    expect(names).toEqual(["ns__printEnv", "ns__get-thing"])
  })

  it("same routed callTool result as old proxy", async () => {
    const calls: string[] = []
    const { session, close } = await makeInMemorySession([{ name: "list_issues" }], (name) => {
      calls.push(name)
      return { result: "ok" }
    })
    cleanups.push(close)

    const provider = {
      listTools: () => session.listTools(),
      callTool: (rawName: string, args: Record<string, unknown>) => session.callTool(rawName, args),
      close: () => session.close(),
    }

    const proxy = createProfileProxy([makeSourceRef("src")], (_sr) =>
      okAsync({ provider, toolNamespace: "src" }),
    )

    const result = await proxy.callTool("src__list_issues", { state: "open" })
    expect(result.isOk()).toBe(true)
    // Old proxy: upstream received the STRIPPED name. New proxy: same.
    expect(calls).toEqual(["list_issues"])
  })

  it("toolFilter works end-to-end through the new chain", async () => {
    const { session, close } = await makeInMemorySession([
      { name: "list_issues" },
      { name: "delete_repo" },
    ])
    cleanups.push(close)

    const filter: ToolFilter = { deny: ["delete_repo"] }
    const provider = {
      listTools: () => session.listTools(),
      callTool: (rawName: string, args: Record<string, unknown>) => session.callTool(rawName, args),
      close: () => session.close(),
    }

    const proxy = createProfileProxy([makeSourceRef("src", filter)], (_sr) =>
      okAsync({ provider, toolNamespace: "src", toolFilter: filter }),
    )

    const listResult = await proxy.listTools()
    expect(listResult.isOk()).toBe(true)
    const names = listResult._unsafeUnwrap().map((t) => t.name)
    expect(names).toContain("src__list_issues")
    expect(names).not.toContain("src__delete_repo")

    // Denied tool must be blocked at callTool too
    const callResult = await proxy.callTool("src__delete_repo", {})
    expect(callResult.isErr()).toBe(true)
    expect(callResult._unsafeUnwrapErr().kind).toBe("tool-denied")
  })
})
