// SPDX-License-Identifier: AGPL-3.0-only
// addGraphQlPlatform tests. Uses a local node:http endpoint for introspection
// (mirrors @junction/graphql-client's provider.test.ts) — I/O-light, no network.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addGraphQlPlatform } from "../graphql.js"

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
      ],
      directives: [],
    },
  },
}

let introspectionEnabled = true
let endpoint: string
let server: ReturnType<typeof createServer>

beforeAll(async () => {
  server = createServer((req, res) => {
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
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: {} }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  endpoint = `http://localhost:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("addGraphQlPlatform", () => {
  it("assembles a Platform and caches the introspected SDL", async () => {
    introspectionEnabled = true
    const result = await addGraphQlPlatform({ id: "gql", displayName: "GQL API", endpoint })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.platform.kind).toBe("graphql")
    expect(result.value.sdlCached).toBe(true)
    expect(result.value.platform.graphql?.schemaSdl).toContain("type Query")
    // User-Agent default seeded even with no caller headers
    expect(result.value.platform.graphql?.defaultHeaders).toEqual({ "User-Agent": "junction" })
  })

  it("merges caller defaultHeaders over the User-Agent seed", async () => {
    const result = await addGraphQlPlatform({
      id: "gql-headers",
      displayName: "GQL API",
      endpoint,
      defaultHeaders: { "User-Agent": "custom-agent", "X-Extra": "1" },
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.platform.graphql?.defaultHeaders).toEqual({
      "User-Agent": "custom-agent",
      "X-Extra": "1",
    })
  })

  it("warns (does not fail) when introspection is disabled", async () => {
    introspectionEnabled = false
    const result = await addGraphQlPlatform({ id: "gql-noint", displayName: "GQL API", endpoint })
    introspectionEnabled = true
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.sdlCached).toBe(false)
    expect(result.value.platform.graphql?.schemaSdl).toBeUndefined()
  })

  it("rejects apiKey-in-query", async () => {
    const result = await addGraphQlPlatform({
      id: "gql-apikey",
      displayName: "GQL API",
      endpoint,
      auth: { scheme: "apiKey", in: "query", name: "api_key" },
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error).toEqual({ kind: "apikey-in-query-unsupported" })
  })

  it("invalid endpoint URL returns invalid-connection", async () => {
    const result = await addGraphQlPlatform({
      id: "gql-bad-url",
      displayName: "GQL API",
      endpoint: "not-a-url",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-connection")
  })
})
