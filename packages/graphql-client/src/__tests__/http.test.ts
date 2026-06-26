// SPDX-License-Identifier: AGPL-3.0-only
// HTTP executor tests — local node:http server (NO network in CI).
// Covers: POST body assembly, credential injection, byte-cap, timeout,
// 200-with-errors isError rule, non-200 mapping.
//
// SECURITY: the sentinel secret MUST NOT appear in any tool result, error
// message, or log. Tests assert presence in the request (server echoes
// RECEIVED/NOT_RECEIVED, never the value) and absence in all output.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { GraphQlConnection } from "@junction/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { callGraphQl, RESPONSE_BYTE_CAP } from "../http.js"

// ---------------------------------------------------------------------------
// Sentinel secret — must never appear in any output
// ---------------------------------------------------------------------------

// Fixed fake test sentinel, never a real credential.
const SENTINEL_SECRET = "gql-s3cr3t-sentinel-xyz789" // gitleaks:allow

// ---------------------------------------------------------------------------
// Local test server
// ---------------------------------------------------------------------------

let serverPort = 0

const testServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${serverPort}`)
  const path = url.pathname

  // POST /graphql — main GraphQL endpoint: echo the request body + auth indicator
  if (path === "/graphql" && req.method === "POST") {
    const authHeader = req.headers.authorization ?? ""
    const apiKeyHeader = req.headers["x-api-key"]
    const receivedBearer = authHeader.startsWith("Bearer ") ? "RECEIVED" : "NOT_RECEIVED"
    const receivedApiKey = apiKeyHeader !== undefined ? "RECEIVED" : "NOT_RECEIVED"
    // NEVER echo back the actual value — only whether it was received

    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(body) as Record<string, unknown>
      } catch {
        // ignore
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          data: {
            receivedBearer,
            receivedApiKey,
            query: parsed.query,
            variables: parsed.variables ?? null,
            operationName: parsed.operationName ?? null,
          },
        }),
      )
    })
    return
  }

  // POST /graphql-errors — returns a 200 with errors + null data (isError:true)
  if (path === "/graphql-errors" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        data: null,
        errors: [{ message: "Something went wrong", locations: [] }],
      }),
    )
    return
  }

  // POST /graphql-partial — returns errors + non-null data (isError:false: partial data)
  if (path === "/graphql-partial" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        data: { viewer: { login: "user" } },
        errors: [{ message: "Some field failed" }],
      }),
    )
    return
  }

  // POST /graphql-401 — simulates auth failure
  if (path === "/graphql-401" && req.method === "POST") {
    res.writeHead(401, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Unauthorized" }))
    return
  }

  // POST /graphql-large — returns a body larger than 1 MB
  if (path === "/graphql-large" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end("x".repeat(RESPONSE_BYTE_CAP + 10))
    return
  }

  // POST /graphql-slow — never responds (timeout test)
  if (path === "/graphql-slow" && req.method === "POST") {
    // Don't respond — let the timeout fire
    return
  }

  // POST /graphql-slowloris — sends headers, then stalls body
  if (path === "/graphql-slowloris" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" })
    res.write('{"dat') // partial JSON — then stall; never call res.end()
    return
  }

  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: "not found" }))
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConn(overrides: Partial<GraphQlConnection> = {}): GraphQlConnection {
  return { endpoint: `http://127.0.0.1:${serverPort}/graphql`, ...overrides }
}

// ---------------------------------------------------------------------------
// POST body assembly
// ---------------------------------------------------------------------------

describe("POST body assembly", () => {
  it("sends query and omits undefined variables/operationName", async () => {
    const result = await callGraphQl(makeConn(), null, "{ viewer { login } }", undefined, undefined)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text) as {
      data: { query: string; variables: null; operationName: null }
    }
    expect(parsed.data.query).toBe("{ viewer { login } }")
    expect(parsed.data.variables).toBeNull()
    expect(parsed.data.operationName).toBeNull()
  })

  it("includes variables when provided", async () => {
    const result = await callGraphQl(
      makeConn(),
      null,
      "query Get($id: ID!) { node(id: $id) { id } }",
      { id: "abc" },
      undefined,
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text) as { data: { variables: { id: string } } }
    expect(parsed.data.variables).toEqual({ id: "abc" })
  })

  it("includes operationName when provided", async () => {
    const result = await callGraphQl(
      makeConn(),
      null,
      "query GetViewer { viewer { login } }",
      undefined,
      "GetViewer",
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text) as { data: { operationName: string } }
    expect(parsed.data.operationName).toBe("GetViewer")
  })
})

// ---------------------------------------------------------------------------
// Credential injection
// ---------------------------------------------------------------------------

describe("credential injection", () => {
  it("bearer: server receives Authorization:Bearer, secret NOT in output", async () => {
    const conn = makeConn({ auth: { scheme: "bearer", header: "Authorization" } })
    const result = await callGraphQl(
      conn,
      SENTINEL_SECRET,
      "{ viewer { login } }",
      undefined,
      undefined,
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const output = JSON.stringify(result.value)
    expect(output).not.toContain(SENTINEL_SECRET)
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text) as { data: { receivedBearer: string } }
    expect(parsed.data.receivedBearer).toBe("RECEIVED")
  })

  it("apiKey-in-header: server receives key, secret NOT in output", async () => {
    const conn = makeConn({ auth: { scheme: "apiKey", in: "header", name: "x-api-key" } })
    const result = await callGraphQl(
      conn,
      SENTINEL_SECRET,
      "{ viewer { login } }",
      undefined,
      undefined,
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const output = JSON.stringify(result.value)
    expect(output).not.toContain(SENTINEL_SECRET)
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text) as { data: { receivedApiKey: string } }
    expect(parsed.data.receivedApiKey).toBe("RECEIVED")
  })

  it("null secret: no auth header injected", async () => {
    const conn = makeConn({ auth: { scheme: "bearer", header: "Authorization" } })
    const result = await callGraphQl(conn, null, "{ viewer { login } }", undefined, undefined)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text) as { data: { receivedBearer: string } }
    expect(parsed.data.receivedBearer).toBe("NOT_RECEIVED")
  })
})

// ---------------------------------------------------------------------------
// isError rule: errors + null data → isError:true; partial → isError:false
// ---------------------------------------------------------------------------

describe("isError rule", () => {
  it("200 with { data } and no errors → isError false", async () => {
    const result = await callGraphQl(makeConn(), null, "{ viewer { login } }", undefined, undefined)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.isError).toBeFalsy()
  })

  it("200 with { errors, data:null } → isError true (verbatim body returned)", async () => {
    const conn = makeConn({ endpoint: `http://127.0.0.1:${serverPort}/graphql-errors` })
    const result = await callGraphQl(conn, null, "{ viewer { login } }", undefined, undefined)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.isError).toBe(true)
    // Errors body is returned verbatim (agent signal)
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("Something went wrong")
  })

  it("200 with { errors, data:non-null } (partial) → isError false", async () => {
    const conn = makeConn({ endpoint: `http://127.0.0.1:${serverPort}/graphql-partial` })
    const result = await callGraphQl(conn, null, "{ viewer { login } }", undefined, undefined)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.isError).toBeFalsy()
  })

  it("non-200 → typed call-failed error (not a successful ToolResult)", async () => {
    const conn = makeConn({ endpoint: `http://127.0.0.1:${serverPort}/graphql-401` })
    const result = await callGraphQl(conn, null, "{ viewer { login } }", undefined, undefined)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("call-failed")
    // The error must NOT contain the secret or endpoint URL
    expect(JSON.stringify(result.error)).not.toContain(SENTINEL_SECRET)
  })
})

// ---------------------------------------------------------------------------
// Byte cap
// ---------------------------------------------------------------------------

describe("response byte cap", () => {
  it("returns response-too-large for a >1 MB response", async () => {
    const conn = makeConn({ endpoint: `http://127.0.0.1:${serverPort}/graphql-large` })
    const result = await callGraphQl(conn, null, "{ __typename }", undefined, undefined)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("response-too-large")
    if (result.error.kind !== "response-too-large") return
    expect(result.error.limit).toBe(RESPONSE_BYTE_CAP)
  })
})

// ---------------------------------------------------------------------------
// Timeout + slowloris guard
// ---------------------------------------------------------------------------

describe("timeout", () => {
  it("returns timed-out when server never responds", async () => {
    const conn = makeConn({ endpoint: `http://127.0.0.1:${serverPort}/graphql-slow` })
    const result = await callGraphQl(conn, null, "{ __typename }", undefined, undefined, 150)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("timed-out")
    if (result.error.kind !== "timed-out") return
    expect(result.error.ms).toBe(150)
  }, 5000)

  it("returns timed-out when server stalls body after sending headers (slowloris)", async () => {
    const conn = makeConn({ endpoint: `http://127.0.0.1:${serverPort}/graphql-slowloris` })
    const startMs = Date.now()
    const result = await callGraphQl(conn, null, "{ __typename }", undefined, undefined, 200)
    const elapsedMs = Date.now() - startMs
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("timed-out")
    expect(elapsedMs).toBeLessThan(3000)
  }, 8000)
})

// ---------------------------------------------------------------------------
// Secret not in error output
// ---------------------------------------------------------------------------

describe("secret guard — errors never contain the credential", () => {
  it("secret absent from call-failed error (non-200 response)", async () => {
    const conn = makeConn({
      endpoint: `http://127.0.0.1:${serverPort}/graphql-401`,
      auth: { scheme: "bearer", header: "Authorization" },
    })
    const result = await callGraphQl(conn, SENTINEL_SECRET, "{ __typename }", undefined, undefined)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(JSON.stringify(result.error)).not.toContain(SENTINEL_SECRET)
  })

  it("secret absent from timed-out error", async () => {
    const conn = makeConn({
      endpoint: `http://127.0.0.1:${serverPort}/graphql-slow`,
      auth: { scheme: "bearer", header: "Authorization" },
    })
    const result = await callGraphQl(
      conn,
      SENTINEL_SECRET,
      "{ __typename }",
      undefined,
      undefined,
      100,
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(JSON.stringify(result.error)).not.toContain(SENTINEL_SECRET)
  }, 5000)
})
