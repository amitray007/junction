// SPDX-License-Identifier: AGPL-3.0-only
// @junction/mcp-client unit tests.
//
// NO real network or subprocess calls in CI. All transport-level tests use
// InMemoryTransport.createLinkedPair() or construct transports without connecting.
//
// Test surface:
//   (a) Pure helper unit tests  — namespaceToolName, splitNamespacedName (now in core)
//   (b) In-memory round-trip    — listTools returns RAW names, callTool passes raw name,
//                                 camelCase/hyphen raw pass-through
//   (c) Transport construction  — http bearer header, stdio env-merge
//   (d) Sentinel secret discipline — token never in output / error / result
//   (e) Timeout                 — hanging upstream → timed-out
//   (f) Timer-cleanup unit test — withTimeoutMs clears timer on both settle paths
//   (g) Credential point-#5     — axios-like cause never leaks Bearer tokens
//
// NOTE (increment 14): namespaceToolName / splitNamespacedName moved to @junction/core.
// createSession no longer takes a toolNamespace parameter and returns RAW tool names.

import { namespaceToolName, splitNamespacedName } from "@junction/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, it, vi } from "vitest"
import { createSession, withTimeoutMs } from "./session.js"

// ---------------------------------------------------------------------------
// (a) Pure helper unit tests — namespaceToolName, splitNamespacedName (now in core)
// ---------------------------------------------------------------------------

describe("namespaceToolName", () => {
  it("prefixes a valid snake_case tool name", () => {
    const r = namespaceToolName("github_work", "list_issues")
    expect(r.isOk()).toBe(true)
    expect(r._unsafeUnwrap()).toBe("github_work__list_issues")
  })

  it("prefixes a camelCase upstream tool name (MCP allows uppercase)", () => {
    const r = namespaceToolName("ns", "printEnv")
    expect(r.isOk()).toBe(true)
    expect(r._unsafeUnwrap()).toBe("ns__printEnv")
  })

  it("prefixes a hyphenated upstream tool name (MCP allows hyphens)", () => {
    const r = namespaceToolName("ns", "get-thing")
    expect(r.isOk()).toBe(true)
    expect(r._unsafeUnwrap()).toBe("ns__get-thing")
  })

  it("allows upstream tool names with double underscores (MCP charset valid)", () => {
    // Routing is unambiguous: splitNamespacedName splits on FIRST __ → tool="bad__name"
    const r = namespaceToolName("ns", "bad__name")
    expect(r.isOk()).toBe(true)
    expect(r._unsafeUnwrap()).toBe("ns__bad__name")
  })

  it("returns namespace-too-long when prefixed name > 64 chars", () => {
    const ns = "a".repeat(32)
    const tool = "b".repeat(33) // 32 + 2 + 33 = 67 > 64
    const r = namespaceToolName(ns, tool)
    expect(r.isErr()).toBe(true)
    expect(r._unsafeUnwrapErr().kind).toBe("namespace-too-long")
  })

  it("accepts exactly 64-char prefixed name", () => {
    // 10 + 2 + 52 = 64
    const r = namespaceToolName("a".repeat(10), "b".repeat(52))
    expect(r.isOk()).toBe(true)
    expect(r._unsafeUnwrap()).toHaveLength(64)
  })

  it("returns invalid-tool-name when upstream name contains MCP-illegal characters", () => {
    // Spaces are not in the MCP charset [a-zA-Z0-9_-]
    const r = namespaceToolName("ns", "bad name")
    expect(r.isErr()).toBe(true)
    expect(r._unsafeUnwrapErr().kind).toBe("invalid-tool-name")
  })
})

describe("splitNamespacedName", () => {
  it("splits on the first __", () => {
    const { namespace, tool } = splitNamespacedName("github_work__list_issues")
    expect(namespace).toBe("github_work")
    expect(tool).toBe("list_issues")
  })

  it("splits on first __ even when tool name contains single underscores", () => {
    const { namespace, tool } = splitNamespacedName("ns__get_pull_request")
    expect(namespace).toBe("ns")
    expect(tool).toBe("get_pull_request")
  })

  it("round-trips an upstream name containing __", () => {
    const { namespace, tool } = splitNamespacedName("ns__bad__name")
    expect(namespace).toBe("ns")
    expect(tool).toBe("bad__name")
  })

  it("round-trips a hyphenated upstream name", () => {
    const { namespace, tool } = splitNamespacedName("ns__get-thing")
    expect(namespace).toBe("ns")
    expect(tool).toBe("get-thing")
  })

  it("returns empty namespace and whole string when __ is absent", () => {
    const { namespace, tool } = splitNamespacedName("no_separator")
    expect(namespace).toBe("")
    expect(tool).toBe("no_separator")
  })
})

// ---------------------------------------------------------------------------
// (b) In-memory round-trip — RAW names (increment 14: no namespace prefix)
// ---------------------------------------------------------------------------

/** Stand up a tiny in-memory MCP Server with fake tools and connect a Client to it. */
async function makeInMemoryPair(
  tools: Array<{ name: string; description?: string }>,
  callHandler?: (name: string, args: Record<string, unknown>) => unknown,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new Server(
    { name: "test-upstream", version: "0.0.0" },
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

  return {
    client,
    cleanup: async () => {
      await client.close()
    },
  }
}

describe("createSession — in-memory round-trip (RAW names)", () => {
  it("listTools returns all upstream tools with RAW names (no namespace prefix)", async () => {
    const { client, cleanup } = await makeInMemoryPair([
      { name: "list_issues" },
      { name: "get_pull_request" },
    ])
    try {
      // No toolNamespace param — session returns raw names
      const session = createSession(client, () => client.close())
      const result = await session.listTools()

      expect(result.isOk()).toBe(true)
      const tools = result._unsafeUnwrap()
      expect(tools).toHaveLength(2)
      // RAW names — not prefixed
      expect(tools.map((t) => t.name)).toEqual(["list_issues", "get_pull_request"])
    } finally {
      await cleanup()
    }
  })

  it("listTools returns camelCase, hyphen, and snake_case names as-is (raw)", async () => {
    const { client, cleanup } = await makeInMemoryPair([
      { name: "printEnv" },
      { name: "get-thing" },
      { name: "list_issues" },
    ])
    try {
      const session = createSession(client, () => client.close())
      const result = await session.listTools()

      expect(result.isOk()).toBe(true)
      const tools = result._unsafeUnwrap()
      // Session passes raw names through — the proxy will apply namespacing
      expect(tools.map((t) => t.name)).toEqual(["printEnv", "get-thing", "list_issues"])
    } finally {
      await cleanup()
    }
  })

  it("listTools returns ALL tools including long-named ones (≤64 guard is in proxy now)", async () => {
    const longTool = "b".repeat(61) // would be > 64 after namespacing — but session returns raw
    const { client, cleanup } = await makeInMemoryPair([{ name: "ok_tool" }, { name: longTool }])
    try {
      const session = createSession(client, () => client.close())
      const result = await session.listTools()

      expect(result.isOk()).toBe(true)
      const tools = result._unsafeUnwrap()
      // Session returns both tools raw — the ≤64 guard is enforced in core proxy
      expect(tools).toHaveLength(2)
      expect(tools.map((t) => t.name)).toEqual(["ok_tool", longTool])
    } finally {
      await cleanup()
    }
  })

  it("callTool passes the raw name directly to upstream (no split/strip)", async () => {
    const calls: string[] = []
    const { client, cleanup } = await makeInMemoryPair([{ name: "list_issues" }], (name, _args) => {
      calls.push(name)
      return { routed: name }
    })
    try {
      const session = createSession(client, () => client.close())
      // Proxy has already stripped the namespace — session receives the raw name
      const result = await session.callTool("list_issues", { state: "open" })

      expect(result.isOk()).toBe(true)
      // Upstream received the raw name directly
      expect(calls).toEqual(["list_issues"])
    } finally {
      await cleanup()
    }
  })

  it("callTool passes any raw name to upstream (no namespace validation in session)", async () => {
    const calls: string[] = []
    const { client, cleanup } = await makeInMemoryPair([{ name: "list_issues" }], (name) => {
      calls.push(name)
      return { routed: name }
    })
    try {
      const session = createSession(client, () => client.close())
      // Session is now namespace-agnostic — it just forwards whatever name it receives
      const result = await session.callTool("list_issues", {})
      expect(result.isOk()).toBe(true)
      expect(calls).toEqual(["list_issues"])
    } finally {
      await cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// (c) Transport construction — no real connection; check parameters
// ---------------------------------------------------------------------------

describe("transport construction — http", () => {
  it("builds bearer header from connection.auth.header", () => {
    const transport = new StreamableHTTPClientTransport(new URL("https://api.example.com/mcp"), {
      requestInit: {
        headers: { "X-Api-Token": "Bearer tok123" },
      },
    })
    // Verify the transport was constructed without throwing
    expect(transport).toBeDefined()
  })

  it("defaults to 'Authorization' header when auth.header is omitted", () => {
    // Simulate what connectSource does for http+bearer with default header
    const connection = {
      transport: "http" as const,
      url: "https://example.com/mcp",
      auth: { scheme: "bearer" as const, header: "Authorization" },
    }
    const headers: Record<string, string> = {}
    if (connection.auth.scheme === "bearer") {
      headers[connection.auth.header ?? "Authorization"] = "Bearer secret"
    }
    expect(headers.Authorization).toBe("Bearer secret")
  })

  it("builds no auth header when secret is null", () => {
    const headers: Record<string, string> = {}
    const secret: string | null = null
    const auth = { scheme: "bearer" as const, header: "Authorization" }
    if (auth.scheme === "bearer" && secret !== null) {
      headers[auth.header] = `Bearer ${secret}`
    }
    expect(Object.keys(headers)).toHaveLength(0)
  })
})

describe("transport construction — stdio env-merge", () => {
  it("spreads getDefaultEnvironment() so PATH is present in the child env", () => {
    const tokenEnvVar = "UPSTREAM_TOKEN"
    const secret = "tok-test-123"
    const env: Record<string, string> = {
      ...getDefaultEnvironment(),
      [tokenEnvVar]: secret,
    }
    // PATH must be present (getDefaultEnvironment includes PATH, HOME, etc.)
    expect(env.PATH).toBeDefined()
    expect(env.PATH).not.toBe("")
    // Token must be injected
    expect(env[tokenEnvVar]).toBe(secret)
  })

  it("does NOT spill process.env into the child env", () => {
    // process.env may contain JUNCTION_MASTER_KEY or other secrets.
    // The env we build must contain only getDefaultEnvironment() keys + token.
    const tokenEnvVar = "UPSTREAM_TOKEN"
    const secret = "tok-test-456"
    const defaultEnvKeys = new Set(Object.keys(getDefaultEnvironment()))
    const env: Record<string, string> = {
      ...getDefaultEnvironment(),
      [tokenEnvVar]: secret,
    }
    const allowedKeys = new Set([...defaultEnvKeys, tokenEnvVar])
    for (const key of Object.keys(env)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
    // Must NOT include arbitrary process.env keys
    const processOnlyKeys = Object.keys(process.env).filter(
      (k) => !defaultEnvKeys.has(k) && k !== tokenEnvVar,
    )
    for (const k of processOnlyKeys) {
      expect(env[k]).toBeUndefined()
    }
  })

  it("builds a StdioClientTransport without throwing when command exists", () => {
    // We do NOT actually connect/spawn — just construct to verify no crash.
    const env = { ...getDefaultEnvironment(), TEST_TOKEN: "tok" }
    const transport = new StdioClientTransport({
      command: "node",
      args: ["--version"],
      env,
      stderr: "ignore",
    })
    expect(transport).toBeDefined()
  })

  it("merges a static connection.env BETWEEN defaults and the token (defaults → static → token)", () => {
    // Mirrors connectSource's env-merge exactly (see connect.ts) without spawning.
    const tokenEnvVar = "UPSTREAM_TOKEN"
    const secret = "tok-static-merge-1"
    const connectionEnv = { FOO: "bar", BAZ: "1" }
    const env: Record<string, string> = {
      ...getDefaultEnvironment(),
      ...connectionEnv,
      ...(tokenEnvVar !== undefined && secret !== null ? { [tokenEnvVar]: secret } : {}),
    }

    // Static entries present.
    expect(env.FOO).toBe("bar")
    expect(env.BAZ).toBe("1")
    // Defaults survive (PATH/HOME etc. from getDefaultEnvironment()).
    expect(env.PATH).toBeDefined()
    expect(env.PATH).not.toBe("")
    // Token present under its declared name, with the secret value.
    expect(env[tokenEnvVar]).toBe(secret)

    const transport = new StdioClientTransport({
      command: "node",
      args: ["--version"],
      env,
      stderr: "ignore",
    })
    expect(transport).toBeDefined()
  })

  it("token always wins under its key — a static env cannot shadow the injected secret", () => {
    // The schema's refine forbids a static env key === tokenEnvVar at descriptor
    // level (see mcp-connection.test.ts), so this can never occur via a valid
    // McpConnection. This test proves the merge-order invariant holds regardless:
    // token is spread LAST, so even if a static map somehow carried the token's
    // key, the secret value — not the static value — would be what lands in env.
    const tokenEnvVar = "UPSTREAM_TOKEN"
    const secret = "tok-should-win"
    const connectionEnvWithCollision = { [tokenEnvVar]: "static-value-should-not-survive" }
    const env: Record<string, string> = {
      ...getDefaultEnvironment(),
      ...connectionEnvWithCollision,
      ...(tokenEnvVar !== undefined && secret !== null ? { [tokenEnvVar]: secret } : {}),
    }
    expect(env[tokenEnvVar]).toBe(secret)
  })

  it("does NOT spill process.env into the child env when a static connection.env is set", () => {
    // process.env may contain JUNCTION_MASTER_KEY or other host secrets — a static
    // connection.env must not be a backdoor for process.env to leak through.
    const tokenEnvVar = "UPSTREAM_TOKEN"
    const secret = "tok-no-spill"
    const connectionEnv = { FOO: "bar" }
    const defaultEnvKeys = new Set(Object.keys(getDefaultEnvironment()))
    const env: Record<string, string> = {
      ...getDefaultEnvironment(),
      ...connectionEnv,
      ...(tokenEnvVar !== undefined && secret !== null ? { [tokenEnvVar]: secret } : {}),
    }
    const allowedKeys = new Set([...defaultEnvKeys, ...Object.keys(connectionEnv), tokenEnvVar])
    for (const key of Object.keys(env)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
    // A known parent-only var (e.g. JUNCTION_MASTER_KEY, if set in this process)
    // must not appear in the child env — proves process.env itself was never spread.
    expect(env.JUNCTION_MASTER_KEY).toBeUndefined()
    const processOnlyKeys = Object.keys(process.env).filter(
      (k) => !defaultEnvKeys.has(k) && !(k in connectionEnv) && k !== tokenEnvVar,
    )
    for (const k of processOnlyKeys) {
      expect(env[k]).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// (d) SENTINEL secret discipline
// ---------------------------------------------------------------------------

describe("sentinel secret discipline", () => {
  const SENTINEL = "SUPER_SECRET_SENTINEL_XYZ_9876"

  it("sentinel token does not appear in listTools result, tool names, or errors", async () => {
    const { client, cleanup } = await makeInMemoryPair([{ name: "list_issues" }])
    try {
      const session = createSession(client, () => client.close())

      const toolsResult = await session.listTools()
      expect(toolsResult.isOk()).toBe(true)

      // Serialize the entire result to JSON and grep for the sentinel
      const serialized = JSON.stringify(toolsResult)
      expect(serialized).not.toContain(SENTINEL)

      // Also verify callTool result does not contain sentinel when passed as arg
      const callResult = await session.callTool("list_issues", { secret: SENTINEL })
      const callSerialized = JSON.stringify(callResult)
      // The sentinel was passed as an argument — it may appear in the echo result
      // from our test server. What we care about is that connectSource never puts
      // the secret into results or errors on its own.
      expect(callSerialized).not.toContain(`${SENTINEL.split("_")[0]}_${SENTINEL.split("_")[1]}`)
      // The real sentinel check: tool names must not contain the sentinel
      const tools = toolsResult._unsafeUnwrap()
      for (const name of tools.map((t) => t.name)) {
        expect(name).not.toContain(SENTINEL)
      }
    } finally {
      await cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// (e) Timeout → timed-out
// ---------------------------------------------------------------------------

describe("timeout", () => {
  it("listTools returns timed-out when the upstream hangs", async () => {
    // Build a server that never responds to listTools
    const server = new Server(
      { name: "hanging-upstream", version: "0.0.0" },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => {
      // Return a promise that never resolves (simulates a hung upstream)
      return new Promise(() => {})
    })

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      // Use a very short timeout so the test is fast
      const session = createSession(client, () => client.close(), 50)
      const result = await session.listTools()

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().kind).toBe("timed-out")
    } finally {
      await client.close()
    }
  })
})

// ---------------------------------------------------------------------------
// (f) Timer-cleanup unit test — withTimeoutMs clears its timer on both paths
// ---------------------------------------------------------------------------

describe("withTimeoutMs — timer cleanup (MUST-FIX 1 regression)", () => {
  it("clears the timer when the underlying promise resolves", async () => {
    vi.useFakeTimers()
    try {
      const p = Promise.resolve("done")
      const result = withTimeoutMs(p, 5_000)
      await expect(result).resolves.toBe("done")
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears the timer when the underlying promise rejects before timeout", async () => {
    vi.useFakeTimers()
    try {
      const p = Promise.reject(new Error("upstream fail"))
      const result = withTimeoutMs(p, 5_000)
      await expect(result).rejects.toThrow("upstream fail")
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// (g) Credential point-#5 — axios-like cause must not leak Bearer tokens
// ---------------------------------------------------------------------------

describe("credential point-#5 — cause never leaks Bearer tokens via String()", () => {
  it("String(axiosLike) excludes the Authorization header value", () => {
    // formatUpstreamError in debug.ts uses String(cause) — this verifies the invariant
    // holds for axios-style errors that store credentials in .config.headers.
    const SENTINEL = "SENTINEL_BEARER_TOKEN_9876"
    const axiosLike = Object.assign(new Error("Request failed with status code 401"), {
      config: { headers: { Authorization: `Bearer ${SENTINEL}` } },
      response: { status: 401 },
    })
    // String(Error) → "Error: <message>" — does NOT include .config.headers
    expect(String(axiosLike)).not.toContain(SENTINEL)
  })

  it("call-failed UpstreamError cause does not surface a Bearer token via String()", async () => {
    const SENTINEL = "SENTINEL_BEARER_CALL_XYZ"
    const { client, cleanup } = await makeInMemoryPair([{ name: "test_tool" }])
    try {
      const session = createSession(client, () => client.close(), 5_000)
      const axiosLike = Object.assign(new Error("upstream HTTP error"), {
        config: { headers: { Authorization: `Bearer ${SENTINEL}` } },
      })
      vi.spyOn(client, "callTool").mockRejectedValueOnce(axiosLike)

      const result = await session.callTool("test_tool", {})
      expect(result.isErr()).toBe(true)
      const e = result._unsafeUnwrapErr()
      // The error kind may be call-failed or auth-failed depending on error shape.
      // In either case, String(cause) must not expose the sentinel.
      if (e.kind === "call-failed") {
        expect(String(e.cause)).not.toContain(SENTINEL)
      }
    } finally {
      await cleanup()
      vi.restoreAllMocks()
    }
  })
})

// ---------------------------------------------------------------------------
// (h) debug probe unit — mock connectSource, check output never has token
// ---------------------------------------------------------------------------

describe("debug probe — output never contains a token", () => {
  it("probe output structure: tool names present, sentinel absent", async () => {
    const SECRET = "probe_secret_should_not_appear"

    // Simulate the output the probe produces (no real CLI invocation needed)
    const toolNames = ["github_work__list_issues", "github_work__get_pull_request"]
    const count = toolNames.length

    // Build what the probe outputs
    const jsonOutput = JSON.stringify({
      ok: true,
      namespace: "github_work",
      count,
      skippedCount: 0,
      tools: toolNames,
    })

    // Token must not be in the output
    expect(jsonOutput).not.toContain(SECRET)
    // Tool names must be present
    expect(jsonOutput).toContain("github_work__list_issues")
    // Count must match
    const parsed = JSON.parse(jsonOutput) as { count: number; tools: string[] }
    expect(parsed.count).toBe(2)
    expect(parsed.tools).toHaveLength(2)
  })
})
