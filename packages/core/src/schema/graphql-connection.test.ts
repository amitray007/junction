// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for GraphQlConnectionSchema — 32.13 Slice D4: the endpoint
// http/https-only scheme refine (mirrors HttpConnectionSchema.baseUrl and
// OpenApiConnectionSchema — inc-30.7 SSRF review precedent).

import { describe, expect, it } from "vitest"
import { GraphQlConnectionSchema } from "./graphql-connection.js"

describe("GraphQlConnectionSchema — endpoint scheme refine (32.13 Slice D4)", () => {
  it("accepts a valid https endpoint", () => {
    const result = GraphQlConnectionSchema.safeParse({
      endpoint: "https://api.github.com/graphql",
    })
    expect(result.success).toBe(true)
  })

  it("accepts a valid http endpoint (e.g. local dev)", () => {
    const result = GraphQlConnectionSchema.safeParse({
      endpoint: "http://localhost:4000/graphql",
    })
    expect(result.success).toBe(true)
  })

  it("REJECTS a file:// endpoint", () => {
    const result = GraphQlConnectionSchema.safeParse({
      endpoint: "file:///etc/passwd",
    })
    expect(result.success).toBe(false)
  })

  it("REJECTS an ftp:// endpoint", () => {
    const result = GraphQlConnectionSchema.safeParse({
      endpoint: "ftp://example.com/graphql",
    })
    expect(result.success).toBe(false)
  })

  it("REJECTS a gopher:// endpoint", () => {
    const result = GraphQlConnectionSchema.safeParse({
      endpoint: "gopher://example.com/graphql",
    })
    expect(result.success).toBe(false)
  })
})
