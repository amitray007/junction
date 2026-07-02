// SPDX-License-Identifier: AGPL-3.0-only
// @junction/mcp-server unit tests — InMemoryTransport round-trip.
//
// Verifies:
//   1. VERIFIED GOTCHA (SDK 1.29): createMcpServer MUST respond to tools/list
//      with the injected tools list, NOT -32601 Method not found.
//      The low-level Server + setRequestHandler(ListToolsRequestSchema) ensures
//      the tools capability is always advertised, regardless of how many tools exist.
//   2. Injected handlers: listTools + callTool are both delegated to the injected
//      McpServerHandlers — the server itself has no tool logic.
//   3. Two profiles produce independent servers (per-profile isolation).
//   4. CallTool wiring: the CallToolRequestSchema handler routes through handlers.callTool.

import type { Profile } from "@junction/core"
import { ProfileIdSchema } from "@junction/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { McpServerHandlers } from "./server.js"
import { createMcpServer } from "./server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(name: string): Profile {
  return {
    id: ProfileIdSchema.parse(`profile-${name}`),
    name,
    sources: [],
  }
}

/** inputSchema that satisfies the MCP SDK's Zod validation (type must be "object"). */
const EMPTY_SCHEMA = { type: "object" as const, properties: {} }

/** Empty handlers — no tools, callTool always errors. */
function emptyHandlers(): McpServerHandlers {
  return {
    listTools: () => Promise.resolve({ tools: [] }),
    callTool: (_name, _args) =>
      Promise.resolve({
        isError: true,
        content: [{ type: "text" as const, text: "no tools" }],
      }),
  }
}

// Reference profile used in callTool tests.
const defaultProfile = makeProfile("default")

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMcpServer", () => {
  let client: Client
  let serverTransport: InMemoryTransport
  let clientTransport: InMemoryTransport

  beforeEach(() => {
    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
    ;[serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  })

  afterEach(async () => {
    await client.close()
  })

  it("tools/list returns empty array (NOT -32601) for a profile with no sources", async () => {
    const profile = makeProfile("default")
    const server = createMcpServer(profile, emptyHandlers())

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const result = await client.listTools()
    expect(result.tools).toEqual([])
  })

  it("tools/list returns the tools from the injected handlers", async () => {
    const profile = makeProfile("work")
    const handlers: McpServerHandlers = {
      listTools: () =>
        Promise.resolve({
          tools: [
            { name: "src__list_issues", description: "List issues", inputSchema: EMPTY_SCHEMA },
            { name: "src__get_issue", description: "Get an issue", inputSchema: EMPTY_SCHEMA },
          ],
        }),
      callTool: (_name, _args) =>
        Promise.resolve({ content: [{ type: "text" as const, text: "ok" }] }),
    }

    const server = createMcpServer(profile, handlers)
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const result = await client.listTools()
    expect(result.tools).toHaveLength(2)
    expect(result.tools.map((t) => t.name)).toEqual(["src__list_issues", "src__get_issue"])
  })

  it("tools/call routes through handlers.callTool and returns its result", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []

    const handlers: McpServerHandlers = {
      listTools: () =>
        Promise.resolve({
          tools: [{ name: "src__greet", description: "Greet", inputSchema: EMPTY_SCHEMA }],
        }),
      callTool: (name, args) => {
        calls.push({ name, args })
        return Promise.resolve({
          content: [{ type: "text" as const, text: `hello from ${name}` }],
        })
      },
    }

    const server = createMcpServer(defaultProfile, handlers)
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const result = await client.callTool({ name: "src__greet", arguments: { who: "world" } })

    // Handler was called with the full namespaced name (server does not strip prefix)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ name: "src__greet", args: { who: "world" } })

    // Result comes from the handler
    expect(result.content).toEqual([{ type: "text", text: "hello from src__greet" }])
  })

  it("tools/call returns isError:true when handler returns isError:true", async () => {
    const handlers: McpServerHandlers = {
      listTools: () =>
        Promise.resolve({ tools: [{ name: "fail__tool", inputSchema: EMPTY_SCHEMA }] }),
      callTool: (_name, _args) =>
        Promise.resolve({
          isError: true,
          content: [{ type: "text" as const, text: "upstream source: connection failed" }],
        }),
    }

    const server = createMcpServer(defaultProfile, handlers)
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const result = await client.callTool({ name: "fail__tool", arguments: {} })
    expect(result.isError).toBe(true)
    // Error message is safe — no secret
    const text = (result.content[0] as { type: "text"; text: string }).text
    expect(text).toContain("connection failed")
    expect(text).not.toContain("SECRET")
  })

  it("two profiles produce independent servers — each returns its own tools", async () => {
    const profileA = makeProfile("work")
    const profileB = makeProfile("personal")

    const serverA = createMcpServer(profileA, {
      listTools: () =>
        Promise.resolve({ tools: [{ name: "work__task", inputSchema: EMPTY_SCHEMA }] }),
      callTool: () => Promise.resolve({ content: [{ type: "text" as const, text: "work" }] }),
    })
    const serverB = createMcpServer(profileB, {
      listTools: () =>
        Promise.resolve({ tools: [{ name: "personal__note", inputSchema: EMPTY_SCHEMA }] }),
      callTool: () => Promise.resolve({ content: [{ type: "text" as const, text: "personal" }] }),
    })

    const [stA, ctA] = InMemoryTransport.createLinkedPair()
    const [stB, ctB] = InMemoryTransport.createLinkedPair()

    const clientA = new Client({ name: "ca", version: "0" }, { capabilities: {} })
    const clientB = new Client({ name: "cb", version: "0" }, { capabilities: {} })

    await serverA.connect(stA)
    await serverB.connect(stB)
    await clientA.connect(ctA)
    await clientB.connect(ctB)

    const [ra, rb] = await Promise.all([clientA.listTools(), clientB.listTools()])

    expect(ra.tools.map((t) => t.name)).toEqual(["work__task"])
    expect(rb.tools.map((t) => t.name)).toEqual(["personal__note"])

    await clientA.close()
    await clientB.close()
  })
})
