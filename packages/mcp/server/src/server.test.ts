// SPDX-License-Identifier: AGPL-3.0-only
// @junction/mcp-server unit tests — InMemoryTransport round-trip.
//
// Verifies the VERIFIED GOTCHA from the method file: createMcpServer MUST
// respond to tools/list with {tools:[]} (empty), NOT -32601 Method not found.
// The low-level Server + setRequestHandler(ListToolsRequestSchema) ensures
// the tools capability is always advertised, regardless of how many tools
// are registered.

import type { Profile } from "@junction/core"
import { deriveMcpEndpointPath, ProfileIdSchema } from "@junction/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMcpServer } from "./server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(name: string): Profile {
  return {
    id: ProfileIdSchema.parse(`profile-${name}`),
    name,
    sources: [],
    mcpEndpointPath: deriveMcpEndpointPath(name),
  }
}

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
    const server = createMcpServer(profile)

    // Connect server to its transport
    await server.connect(serverTransport)
    // Connect client to the paired transport
    await client.connect(clientTransport)

    const result = await client.listTools()

    expect(result.tools).toEqual([])
  })

  it("two profiles produce independent servers — each returns empty tools", async () => {
    const profileA = makeProfile("work")
    const profileB = makeProfile("personal")

    const serverA = createMcpServer(profileA)
    const serverB = createMcpServer(profileB)

    const [serverTransportA, clientTransportA] = InMemoryTransport.createLinkedPair()
    const [serverTransportB, clientTransportB] = InMemoryTransport.createLinkedPair()

    const clientA = new Client({ name: "client-a", version: "0.0.0" }, { capabilities: {} })
    const clientB = new Client({ name: "client-b", version: "0.0.0" }, { capabilities: {} })

    await serverA.connect(serverTransportA)
    await serverB.connect(serverTransportB)
    await clientA.connect(clientTransportA)
    await clientB.connect(clientTransportB)

    const [resultA, resultB] = await Promise.all([clientA.listTools(), clientB.listTools()])

    expect(resultA.tools).toEqual([])
    expect(resultB.tools).toEqual([])

    await clientA.close()
    await clientB.close()
  })
})
