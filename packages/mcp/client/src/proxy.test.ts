// SPDX-License-Identifier: AGPL-3.0-only
// createProfileProxy tests — in-memory end-to-end, no network/subprocess.
//
// TEST SEAM: createProfileProxy accepts an optional sessionFactory parameter
// (default: connectSource). Tests inject a factory that returns pre-connected
// InMemoryTransport sessions, letting us test all proxy logic without real transports.
//
// Test surface:
//   (a) End-to-end proxy       — listTools + callTool through the proxy
//   (b) Multi-source           — two namespaces list and route correctly
//   (c) Per-source resilience  — one dead source does not kill the profile
//   (d) toolFilter (allow/deny)— only permitted upstream tools surface
//   (e) Sentinel credential    — secret never appears in any agent-facing output
//   (f) tool-not-found         — missing namespace returns clean error

import type { McpConnection, SourceRef, ToolFilter, UpstreamError } from "@junction/core"
import { CredentialIdSchema, PlatformIdSchema } from "@junction/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { errAsync, okAsync } from "neverthrow"
import { afterEach, describe, expect, it } from "vitest"
import type { SessionFactory } from "./proxy.js"
import { createProfileProxy } from "./proxy.js"
import type { UpstreamSession } from "./session.js"
import { createSession } from "./session.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub McpConnection — never actually used (tests inject sessions via sessionFactory). */
const STUB_CONNECTION: McpConnection = { transport: "stdio", command: "stub", args: [] }

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
 * Build an UpstreamSession backed by an in-memory MCP server.
 * The returned session already has the namespace applied (via createSession).
 */
async function makeInMemorySession(
  namespace: string,
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

  const session = createSession(client, namespace, () => client.close())
  return { session, close: () => client.close() }
}

/**
 * Build a SessionFactory that returns the pre-built session for the matching namespace.
 * Returns Err(connect-failed) for namespaces with no entry in the map.
 */
function makeSessionFactory(sessionMap: Map<string, UpstreamSession>): SessionFactory {
  return (_connection, toolNamespace, _secret) => {
    const session = sessionMap.get(toolNamespace)
    if (session === undefined) {
      return errAsync({
        kind: "connect-failed",
        cause: "no test session for namespace",
      } satisfies UpstreamError)
    }
    return okAsync(session)
  }
}

/** resolveSource stub: always Ok with the given toolNamespace and no filter. */
function resolveOk(toolNamespace: string, toolFilter?: ToolFilter) {
  return () =>
    okAsync({
      connection: STUB_CONNECTION,
      secret: null,
      toolNamespace,
      toolFilter,
    })
}

/** resolveSource stub: always Err. */
function resolveErr(): () => ReturnType<SessionFactory> {
  return () => errAsync({ kind: "connect-failed", cause: "resolve failed" } satisfies UpstreamError)
}

// ---------------------------------------------------------------------------
// (a) End-to-end proxy — listTools + callTool
// ---------------------------------------------------------------------------

describe("createProfileProxy — listTools", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups) await c()
    cleanups.length = 0
  })

  it("returns namespaced tools for a single source", async () => {
    const { session, close } = await makeInMemorySession("src", [
      { name: "list_issues" },
      { name: "get_pull_request" },
    ])
    cleanups.push(close)

    const proxy = createProfileProxy(
      [makeSourceRef("src")],
      resolveOk("src"),
      makeSessionFactory(new Map([["src", session]])),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap().map((t) => t.name)).toEqual([
      "src__list_issues",
      "src__get_pull_request",
    ])
  })
})

describe("createProfileProxy — callTool", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups) await c()
    cleanups.length = 0
  })

  it("routes the call to the upstream and returns its result", async () => {
    const calls: string[] = []
    const { session, close } = await makeInMemorySession(
      "src",
      [{ name: "list_issues" }],
      (name) => {
        calls.push(name)
        return { routed: name }
      },
    )
    cleanups.push(close)

    const proxy = createProfileProxy(
      [makeSourceRef("src")],
      resolveOk("src"),
      makeSessionFactory(new Map([["src", session]])),
    )

    const result = await proxy.callTool("src__list_issues", { state: "open" })
    expect(result.isOk()).toBe(true)
    // The upstream received the STRIPPED name (session strips namespace prefix)
    expect(calls).toEqual(["list_issues"])
  })
})

// ---------------------------------------------------------------------------
// (b) Multi-source namespacing
// ---------------------------------------------------------------------------

describe("createProfileProxy — multi-source", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups) await c()
    cleanups.length = 0
  })

  it("lists tools from both sources under their namespaces", async () => {
    const { session: workSess, close: closeWork } = await makeInMemorySession("work", [
      { name: "list_projects" },
    ])
    const { session: personalSess, close: closePersonal } = await makeInMemorySession("personal", [
      { name: "list_notes" },
    ])
    cleanups.push(closeWork, closePersonal)

    const sessionMap = new Map([
      ["work", workSess],
      ["personal", personalSess],
    ])

    const sources = [makeSourceRef("work"), makeSourceRef("personal")]
    const proxy = createProfileProxy(
      sources,
      (sr) => resolveOk(sr.toolNamespace)(sr),
      makeSessionFactory(sessionMap),
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

    const { session: workSess, close: closeWork } = await makeInMemorySession(
      "work",
      [{ name: "list_projects" }],
      (n) => {
        workCalls.push(n)
        return { from: "work" }
      },
    )
    const { session: personalSess, close: closePersonal } = await makeInMemorySession(
      "personal",
      [{ name: "list_notes" }],
      (n) => {
        personalCalls.push(n)
        return { from: "personal" }
      },
    )
    cleanups.push(closeWork, closePersonal)

    const sessionMap = new Map([
      ["work", workSess],
      ["personal", personalSess],
    ])
    const sources = [makeSourceRef("work"), makeSourceRef("personal")]
    const proxy = createProfileProxy(
      sources,
      (sr) => resolveOk(sr.toolNamespace)(sr),
      makeSessionFactory(sessionMap),
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
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups) await c()
    cleanups.length = 0
  })

  it("a source that fails resolveSource is skipped; the rest still list", async () => {
    const { session: goodSess, close } = await makeInMemorySession("good", [{ name: "tool_a" }])
    cleanups.push(close)

    const sessionMap = new Map([["good", goodSess]])
    const sources = [makeSourceRef("bad"), makeSourceRef("good")]

    // "bad" source's resolveSource always fails
    const proxy = createProfileProxy(
      sources,
      (sr) => (sr.toolNamespace === "bad" ? resolveErr()(sr) : resolveOk(sr.toolNamespace)(sr)),
      makeSessionFactory(sessionMap),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toEqual(["good__tool_a"])
  })

  it("a source that fails to connect is skipped; the rest still list", async () => {
    const { session: goodSess, close } = await makeInMemorySession("good", [{ name: "tool_a" }])
    cleanups.push(close)

    // sessionMap has no entry for "bad" → sessionFactory returns Err → source skipped
    const sessionMap = new Map([["good", goodSess]])
    const sources = [makeSourceRef("bad"), makeSourceRef("good")]

    const proxy = createProfileProxy(
      sources,
      (sr) => resolveOk(sr.toolNamespace)(sr),
      makeSessionFactory(sessionMap),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap().map((t) => t.name)).toEqual(["good__tool_a"])
  })

  it("callTool to a dead namespace returns a clean Err (tool-not-found or connect-failed)", async () => {
    // No sessions at all → every source fails to connect
    const sources = [makeSourceRef("src")]
    const proxy = createProfileProxy(
      sources,
      resolveOk("src"),
      makeSessionFactory(new Map()), // empty → no session → connect fails
    )

    const result = await proxy.callTool("src__some_tool", {})
    expect(result.isErr()).toBe(true)
    const kind = result._unsafeUnwrapErr().kind
    expect(["connect-failed", "tool-not-found"]).toContain(kind)
  })

  it("callTool to a completely unknown namespace returns tool-not-found", async () => {
    const sources = [makeSourceRef("src")]
    const proxy = createProfileProxy(sources, resolveOk("src"), makeSessionFactory(new Map()))

    const result = await proxy.callTool("unknown__tool", {})
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().kind).toBe("tool-not-found")
  })
})

// ---------------------------------------------------------------------------
// (d) toolFilter
// ---------------------------------------------------------------------------

describe("createProfileProxy — toolFilter", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups) await c()
    cleanups.length = 0
  })

  it("allow list: only permitted upstream tool names surface", async () => {
    const { session, close } = await makeInMemorySession("src", [
      { name: "list_issues" },
      { name: "get_pull_request" },
      { name: "delete_repo" },
    ])
    cleanups.push(close)

    const filter: ToolFilter = { allow: ["list_issues", "get_pull_request"] }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", filter),
      makeSessionFactory(new Map([["src", session]])),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toContain("src__list_issues")
    expect(names).toContain("src__get_pull_request")
    expect(names).not.toContain("src__delete_repo")
  })

  it("deny list: denied upstream tools are excluded", async () => {
    const { session, close } = await makeInMemorySession("src", [
      { name: "list_issues" },
      { name: "delete_repo" },
    ])
    cleanups.push(close)

    const filter: ToolFilter = { deny: ["delete_repo"] }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", filter),
      makeSessionFactory(new Map([["src", session]])),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toContain("src__list_issues")
    expect(names).not.toContain("src__delete_repo")
  })

  it("allow + deny: allow first, then deny removes the overlap", async () => {
    const { session, close } = await makeInMemorySession("src", [
      { name: "list_issues" },
      { name: "get_issue" },
      { name: "delete_issue" },
    ])
    cleanups.push(close)

    const filter: ToolFilter = {
      allow: ["list_issues", "get_issue", "delete_issue"],
      deny: ["delete_issue"],
    }
    const proxy = createProfileProxy(
      [makeSourceRef("src", filter)],
      resolveOk("src", filter),
      makeSessionFactory(new Map([["src", session]])),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    const names = result._unsafeUnwrap().map((t) => t.name)
    expect(names).toEqual(["src__list_issues", "src__get_issue"])
  })
})

// ---------------------------------------------------------------------------
// (e) Sentinel credential discipline
// ---------------------------------------------------------------------------

describe("createProfileProxy — sentinel credential discipline", () => {
  const SENTINEL = "SUPER_SECRET_SENTINEL_TOKEN_XYZ_9876"

  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups) await c()
    cleanups.length = 0
  })

  it("sentinel secret does not appear in listTools result", async () => {
    const { session, close } = await makeInMemorySession("src", [{ name: "tool_a" }])
    cleanups.push(close)

    // resolveSource "receives" the sentinel as the secret; the proxy must never surface it.
    // Here we pass it in secret to show it never leaks into the tool list.
    const proxy = createProfileProxy(
      [makeSourceRef("src")],
      () =>
        okAsync({
          connection: STUB_CONNECTION,
          secret: SENTINEL, // sentinel as the secret
          toolNamespace: "src",
          toolFilter: undefined,
        }),
      makeSessionFactory(new Map([["src", session]])),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)

    const serialized = JSON.stringify(result._unsafeUnwrap())
    expect(serialized).not.toContain(SENTINEL)
  })

  it("sentinel secret does not appear in callTool result", async () => {
    const { session, close } = await makeInMemorySession("src", [{ name: "greet" }], () => ({
      message: "hello",
    }))
    cleanups.push(close)

    const proxy = createProfileProxy(
      [makeSourceRef("src")],
      () =>
        okAsync({
          connection: STUB_CONNECTION,
          secret: SENTINEL,
          toolNamespace: "src",
          toolFilter: undefined,
        }),
      makeSessionFactory(new Map([["src", session]])),
    )

    const result = await proxy.callTool("src__greet", {})
    expect(result.isOk()).toBe(true)

    const serialized = JSON.stringify(result._unsafeUnwrap())
    expect(serialized).not.toContain(SENTINEL)
  })

  it("sentinel secret does not appear in error results", async () => {
    // callTool on a non-existent namespace → tool-not-found error
    const proxy = createProfileProxy(
      [makeSourceRef("src")],
      () =>
        okAsync({
          connection: STUB_CONNECTION,
          secret: SENTINEL,
          toolNamespace: "src",
          toolFilter: undefined,
        }),
      makeSessionFactory(new Map()),
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
    const { session, close } = await makeInMemorySession("src", [{ name: "tool_a" }])

    const sources = [makeSourceRef("src", undefined, false)] // disabled
    const proxy = createProfileProxy(
      sources,
      resolveOk("src"),
      makeSessionFactory(new Map([["src", session]])),
    )

    const result = await proxy.listTools()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toHaveLength(0)

    const callResult = await proxy.callTool("src__tool_a", {})
    expect(callResult.isErr()).toBe(true)

    await close()
  })
})
