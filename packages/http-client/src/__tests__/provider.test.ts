// SPDX-License-Identifier: AGPL-3.0-only
// createHttpProvider tests — local node:http server (NO network in CI).
// Covers: listTools shape, path+query binding, JSON body, auth injection
// (present-in-request / ABSENT-from-ToolResult), path-injection guard,
// 4xx → isError, unknown tool, and timeout.
//
// SECURITY: the sentinel secret MUST NOT appear in any tool result, error
// message, or log. Tests assert presence in the request (server echoes
// RECEIVED/NOT_RECEIVED, never the value) and absence in all output.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { HttpConnection } from "@junction/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createHttpProvider } from "../provider.js"

// Fixed fake test sentinel, never a real credential.
const SENTINEL_SECRET = "s3cr3t-sentinel-http-abc123" // gitleaks:allow

// ---------------------------------------------------------------------------
// Local test server
// ---------------------------------------------------------------------------

let serverPort = 0

const testServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${serverPort}`)
  const path = url.pathname

  // GET /repos/{owner}/{repo}/issues?state=... — echoes the resolved path + query
  const issuesMatch = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path)
  if (issuesMatch && req.method === "GET") {
    const auth = req.headers.authorization ?? ""
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        owner: issuesMatch[1],
        repo: issuesMatch[2],
        state: url.searchParams.get("state"),
        bearer: auth.startsWith("Bearer ") ? "RECEIVED" : "NOT_RECEIVED",
      }),
    )
    return
  }

  // POST /issues — echoes the JSON body + auth
  if (path === "/issues" && req.method === "POST") {
    const auth = req.headers.authorization ?? ""
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      res.writeHead(201, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          bearer: auth.startsWith("Bearer ") ? "RECEIVED" : "NOT_RECEIVED",
          body: body ? (JSON.parse(body) as unknown) : null,
        }),
      )
    })
    return
  }

  // GET /secure — 401 without a bearer token
  if (path === "/secure" && req.method === "GET") {
    const auth = req.headers.authorization ?? ""
    if (!auth.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ secured: true }))
    return
  }

  // GET /slow — never responds (timeout test)
  if (path === "/slow" && req.method === "GET") {
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
// Connection factory
// ---------------------------------------------------------------------------

function baseUrl(): string {
  return `http://127.0.0.1:${serverPort}`
}

function makeConnection(overrides: Partial<HttpConnection> = {}): HttpConnection {
  return {
    baseUrl: baseUrl(),
    tools: [
      {
        name: "listIssues",
        description: "List issues for a repo",
        method: "GET",
        path: "/repos/{owner}/{repo}/issues",
        params: [
          { name: "owner", in: "path", type: "string", required: true },
          { name: "repo", in: "path", type: "string", required: true },
          { name: "state", in: "query", type: "string", required: false },
        ],
      },
      {
        name: "createIssue",
        description: "Create an issue",
        method: "POST",
        path: "/issues",
        params: [{ name: "payload", in: "body", type: "string", required: true }],
      },
      {
        name: "getSecure",
        description: "A secured GET endpoint",
        method: "GET",
        path: "/secure",
        params: [],
      },
      {
        name: "getSlow",
        description: "Never responds",
        method: "GET",
        path: "/slow",
        params: [],
        timeoutMs: 200,
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// listTools
// ---------------------------------------------------------------------------

describe("listTools", () => {
  it("returns one ProviderTool per declared request-tool with the right inputSchema shape", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value).toHaveLength(4)

    const listIssues = result.value.find((t) => t.name === "listIssues")
    expect(listIssues).toBeDefined()
    expect(listIssues?.description).toBe("List issues for a repo")
    expect(listIssues?.inputSchema).toEqual({
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string" },
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    })

    const createIssue = result.value.find((t) => t.name === "createIssue")
    expect(createIssue?.inputSchema).toEqual({
      type: "object",
      properties: { payload: { type: "string" } },
      required: ["payload"],
      additionalProperties: false,
    })
  })
})

// ---------------------------------------------------------------------------
// GET: path + query binding
// ---------------------------------------------------------------------------

describe("GET tool — path + query binding", () => {
  it("substitutes path params and appends query params (server receives the right URL)", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.callTool("listIssues", {
      owner: "junction-org",
      repo: "junction",
      state: "open",
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.isError).toBeFalsy()
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text.replace(/^\d+ [^\n]*\n/, "")) as Record<string, unknown>
    expect(parsed.owner).toBe("junction-org")
    expect(parsed.repo).toBe("junction")
    expect(parsed.state).toBe("open")
  })

  it("omits an absent optional query param", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.callTool("listIssues", {
      owner: "a",
      repo: "b",
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text.replace(/^\d+ [^\n]*\n/, "")) as Record<string, unknown>
    expect(parsed.state).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// POST: JSON body
// ---------------------------------------------------------------------------

describe("POST tool — JSON body", () => {
  it("sends the body param's value as the JSON body (server receives it)", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.callTool("createIssue", {
      payload: JSON.stringify({ title: "bug" }),
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text.replace(/^\d+ [^\n]*\n/, "")) as Record<string, unknown>
    // The body param's raw string value is what gets JSON.stringify'd as the
    // outbound body (buildAndExecuteRequest does JSON.stringify(args[bodyArgKey])) —
    // so the server receives a JSON-encoded STRING, not the nested object.
    expect(parsed.body).toBe(JSON.stringify({ title: "bug" }))
  })
})

// ---------------------------------------------------------------------------
// Auth injection — present in request, ABSENT from ToolResult
// ---------------------------------------------------------------------------

describe("auth injection", () => {
  it("the secret is present in the outgoing Authorization header, absent from the ToolResult", async () => {
    const conn = makeConnection({ auth: { scheme: "bearer", header: "Authorization" } })
    const provider = createHttpProvider(conn, SENTINEL_SECRET)
    const result = await provider.callTool("createIssue", { payload: "{}" })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    // Adversarial: stringify the WHOLE ToolResult, assert the secret substring is absent.
    const output = JSON.stringify(result.value)
    expect(output).not.toContain(SENTINEL_SECRET)

    // Server-side proof the header WAS received.
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    const parsed = JSON.parse(text.replace(/^\d+ [^\n]*\n/, "")) as Record<string, unknown>
    expect(parsed.bearer).toBe("RECEIVED")
  })

  it("end-to-end: /secure WITH bearer → 200; WITHOUT → 401", async () => {
    const conn = makeConnection({ auth: { scheme: "bearer", header: "Authorization" } })
    const provider = createHttpProvider(conn, SENTINEL_SECRET)

    const withAuth = await provider.callTool("getSecure", {})
    expect(withAuth.isOk()).toBe(true)
    if (withAuth.isOk()) {
      expect(withAuth.value.isError).toBeFalsy()
      expect(JSON.stringify(withAuth.value)).not.toContain(SENTINEL_SECRET)
    }

    const noAuthProvider = createHttpProvider(makeConnection(), null)
    const withoutAuth = await noAuthProvider.callTool("getSecure", {})
    expect(withoutAuth.isOk()).toBe(true)
    if (withoutAuth.isOk()) {
      expect(withoutAuth.value.isError).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Path-injection guard
// ---------------------------------------------------------------------------

describe("path-injection guard", () => {
  it("rejects a path param value containing '../' — no request made", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.callTool("listIssues", {
      owner: "../etc",
      repo: "passwd",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })

  it("rejects a path param value containing '/'", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.callTool("listIssues", {
      owner: "a/b",
      repo: "c",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })
})

// ---------------------------------------------------------------------------
// 4xx → isError
// ---------------------------------------------------------------------------

describe("4xx response", () => {
  it("maps a 401 response to isError:true", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.callTool("getSecure", {})
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.isError).toBe(true)
    const text = (result.value.content as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("401")
  })
})

// ---------------------------------------------------------------------------
// Unknown tool name
// ---------------------------------------------------------------------------

describe("unknown tool", () => {
  it("returns tool-not-found for an undeclared tool name", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.callTool("doesNotExist", {})
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("tool-not-found")
  })
})

// ---------------------------------------------------------------------------
// Unknown arg keys / missing required args
// ---------------------------------------------------------------------------

describe("arg validation", () => {
  it("rejects an unknown arg key", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.callTool("listIssues", {
      owner: "a",
      repo: "b",
      bogus: "x",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })

  it("rejects a missing required arg", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const result = await provider.callTool("listIssues", { owner: "a" })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })
})

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  it("returns timed-out for a slow endpoint with a short per-tool timeoutMs", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    const startMs = Date.now()
    const result = await provider.callTool("getSlow", {})
    const elapsedMs = Date.now() - startMs

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("timed-out")
    // Must resolve close to the tool's declared 200ms timeout, not the 30s default.
    expect(elapsedMs).toBeLessThan(3000)
  }, 8000)
})

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("close", () => {
  it("resolves with no error (stateless no-op)", async () => {
    const provider = createHttpProvider(makeConnection(), null)
    await expect(provider.close()).resolves.toBeUndefined()
  })
})
