// SPDX-License-Identifier: AGPL-3.0-only
// Provider tests — createGraphQlProvider: listTools shape, callTool dispatch,
// maxQueryBytes guard, graphql_schema cached vs live vs disabled,
// and the no-token-in-output sentinel test.
//
// Uses a local node:http GraphQL endpoint for executor + introspection tests.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { GraphQlConnection } from "@junction/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGraphQlProvider } from "../provider.js"

// ---------------------------------------------------------------------------
// Sentinel secret
// ---------------------------------------------------------------------------

const SENTINEL_SECRET = "prov-s3cr3t-sentinel-abc456" // gitleaks:allow

// ---------------------------------------------------------------------------
// Local test server — minimal GraphQL endpoint
// ---------------------------------------------------------------------------

const SIMPLE_SCHEMA_SDL = `
type Query {
  viewer: User
}

type User {
  login: String
}
`

// A minimal introspection response that buildClientSchema can handle
const INTROSPECTION_RESPONSE = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          description: null,
          fields: [
            {
              name: "viewer",
              description: null,
              args: [],
              type: { kind: "OBJECT", name: "User", ofType: null },
              isDeprecated: false,
              deprecationReason: null,
            },
          ],
          inputFields: null,
          interfaces: [],
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: "OBJECT",
          name: "User",
          description: null,
          fields: [
            {
              name: "login",
              description: null,
              args: [],
              type: { kind: "SCALAR", name: "String", ofType: null },
              isDeprecated: false,
              deprecationReason: null,
            },
          ],
          inputFields: null,
          interfaces: [],
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: "SCALAR",
          name: "String",
          description: null,
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: "SCALAR",
          name: "Boolean",
          description: null,
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
      ],
      directives: [],
    },
  },
}

let serverPort = 0
let introspectionEnabled = true

const testServer = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405)
    res.end()
    return
  }

  let body = ""
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString()
  })
  req.on("end", () => {
    let parsed: { query?: string } = {}
    try {
      parsed = JSON.parse(body) as { query?: string }
    } catch {
      // ignore
    }

    const authHeader = req.headers.authorization ?? ""
    const receivedBearer = authHeader.startsWith("Bearer ") ? "RECEIVED" : "NOT_RECEIVED"

    // Introspection query detection
    const isIntrospection = typeof parsed.query === "string" && parsed.query.includes("__schema")

    if (isIntrospection && !introspectionEnabled) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ errors: [{ message: "introspection disabled" }], data: null }))
      return
    }

    if (isIntrospection) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(INTROSPECTION_RESPONSE))
      return
    }

    // Regular query — echo query + auth indicator
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        data: {
          receivedBearer,
          query: parsed.query,
          // NEVER echo the actual secret value — only presence indicator
        },
      }),
    )
  })
})

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      testServer.listen(0, "127.0.0.1", () => {
        serverPort = (testServer.address() as AddressInfo).port
        resolve()
      })
    }),
)

afterAll(
  () =>
    new Promise<void>((resolve) => {
      testServer.close(() => resolve())
    }),
)

function makeConn(overrides: Partial<GraphQlConnection> = {}): GraphQlConnection {
  return { endpoint: `http://127.0.0.1:${serverPort}`, ...overrides }
}

// ---------------------------------------------------------------------------
// listTools — exactly 3 tools with correct shapes
// ---------------------------------------------------------------------------

describe("listTools", () => {
  it("returns exactly 3 tools with correct names", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const tools = result.value
    expect(tools).toHaveLength(3)
    const names = tools.map((t) => t.name)
    expect(names).toContain("graphql_query")
    expect(names).toContain("graphql_mutation")
    expect(names).toContain("graphql_schema")
  })

  it("graphql_query and graphql_mutation have required 'query' in inputSchema", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.listTools()
    if (!result.isOk()) return
    for (const name of ["graphql_query", "graphql_mutation"]) {
      const tool = result.value.find((t) => t.name === name)
      expect(tool).toBeDefined()
      const schema = tool?.inputSchema as { required?: string[] }
      expect(schema.required).toContain("query")
    }
  })

  it("graphql_schema has empty required array", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.listTools()
    if (!result.isOk()) return
    const tool = result.value.find((t) => t.name === "graphql_schema")
    expect(tool).toBeDefined()
    const schema = tool?.inputSchema as { required?: string[] }
    expect(schema.required).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// callTool — graphql_query and graphql_mutation enforce operation type
// ---------------------------------------------------------------------------

describe("callTool — operation-type enforcement", () => {
  it("graphql_query rejects a mutation document", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.callTool("graphql_query", {
      query: "mutation CreateIssue { createIssue { id } }",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
    expect(result.error.reason).toContain("mutation")
  })

  it("graphql_query rejects a subscription document", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.callTool("graphql_query", {
      query: "subscription OnMsg { messageAdded { id } }",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
    expect(result.error.reason).toContain("subscription")
  })

  it("graphql_mutation rejects a query document", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.callTool("graphql_mutation", {
      query: "{ viewer { login } }",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
    expect(result.error.reason).toContain("query")
  })

  it("graphql_query accepts a valid query and POSTs to the endpoint", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.callTool("graphql_query", {
      query: "{ viewer { login } }",
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.isError).toBeFalsy()
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("receivedBearer")
  })

  it("graphql_query rejects a syntax error with invalid-args", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.callTool("graphql_query", { query: "{ unclosed" })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })
})

// ---------------------------------------------------------------------------
// callTool — maxQueryBytes guard
// ---------------------------------------------------------------------------

describe("callTool — maxQueryBytes guard", () => {
  it("rejects a query document exceeding maxQueryBytes", async () => {
    const provider = createGraphQlProvider(makeConn({ maxQueryBytes: 50 }), null)
    const bigQuery = "{ " + "viewer { login } ".repeat(10) + "}"
    const result = await provider.callTool("graphql_query", { query: bigQuery })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
    expect(result.error.reason).toContain("maxQueryBytes")
  })

  it("accepts a query within maxQueryBytes", async () => {
    const provider = createGraphQlProvider(makeConn({ maxQueryBytes: 1000 }), null)
    const result = await provider.callTool("graphql_query", { query: "{ viewer { login } }" })
    expect(result.isOk()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// callTool — auth injection (no token in output)
// ---------------------------------------------------------------------------

describe("callTool — credential injection, no token in output", () => {
  it("bearer token received by server, NOT in tool result content", async () => {
    const conn = makeConn({ auth: { scheme: "bearer", header: "Authorization" } })
    const provider = createGraphQlProvider(conn, SENTINEL_SECRET)
    const result = await provider.callTool("graphql_query", { query: "{ viewer { login } }" })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    // Sentinel must not appear in any output
    const outputStr = JSON.stringify(result.value)
    expect(outputStr).not.toContain(SENTINEL_SECRET)
    // Server confirms it received the bearer token
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text) as { data: { receivedBearer: string } }
    expect(parsed.data.receivedBearer).toBe("RECEIVED")
  })
})

// ---------------------------------------------------------------------------
// callTool — graphql_schema: cached vs live vs introspection-disabled
// ---------------------------------------------------------------------------

describe("callTool — graphql_schema", () => {
  it("returns cached schemaSdl immediately without network call", async () => {
    const conn = makeConn({ schemaSdl: SIMPLE_SCHEMA_SDL })
    const provider = createGraphQlProvider(conn, null)
    const result = await provider.callTool("graphql_schema", {})
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toBe(SIMPLE_SCHEMA_SDL)
    expect(result.value.isError).toBeFalsy()
  })

  it("live-introspects when no schemaSdl is cached", async () => {
    introspectionEnabled = true
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.callTool("graphql_schema", {})
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    // Should contain SDL-style content (type Query, type User)
    expect(text).toContain("Query")
    expect(text).toContain("User")
    expect(result.value.isError).toBeFalsy()
  })

  it("degrades gracefully when introspection is disabled (no crash, source still usable)", async () => {
    introspectionEnabled = false
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.callTool("graphql_schema", {})
    // Should NOT error — graceful degradation
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("not available")
    expect(result.value.isError).toBeFalsy()

    // Verify execution tools still work after introspection failure
    introspectionEnabled = true
    const queryResult = await provider.callTool("graphql_query", { query: "{ viewer { login } }" })
    expect(queryResult.isOk()).toBe(true)
  })

  it("caches SDL from live introspection on subsequent calls", async () => {
    introspectionEnabled = true
    const provider = createGraphQlProvider(makeConn(), null)
    // First call: live introspect
    const first = await provider.callTool("graphql_schema", {})
    expect(first.isOk()).toBe(true)
    // Disable introspection — second call should still succeed from cache
    introspectionEnabled = false
    const second = await provider.callTool("graphql_schema", {})
    expect(second.isOk()).toBe(true)
    if (!second.isOk()) return
    const text = (second.value.content as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("Query") // still serving cached SDL
    introspectionEnabled = true
  })
})

// ---------------------------------------------------------------------------
// callTool — tool-not-found for unknown raw name
// ---------------------------------------------------------------------------

describe("callTool — unknown tool name", () => {
  it("returns tool-not-found for an unknown raw name", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    const result = await provider.callTool("nonexistent_tool", {})
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("tool-not-found")
  })
})

// ---------------------------------------------------------------------------
// close — no-op
// ---------------------------------------------------------------------------

describe("close", () => {
  it("resolves without error", async () => {
    const provider = createGraphQlProvider(makeConn(), null)
    await expect(provider.close()).resolves.toBeUndefined()
  })
})
