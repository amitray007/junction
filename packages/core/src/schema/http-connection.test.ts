// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for HttpConnectionSchema — authoring round-trip + security refines.

import { describe, expect, it } from "vitest"
import { HttpConnectionSchema, HttpParamSchema, HttpRequestToolSchema } from "./http-connection.js"
import { PlatformSchema } from "./platform.js"

const getIssueTool = {
  name: "listIssues",
  description: "List issues for a repo",
  method: "GET",
  path: "/repos/{owner}/{repo}/issues",
  params: [
    { name: "owner", in: "path", type: "string", required: true },
    { name: "repo", in: "path", type: "string", required: true },
    { name: "state", in: "query", type: "enum", enum: ["open", "closed"], required: false },
  ],
}

const createIssueTool = {
  name: "createIssue",
  description: "Create an issue",
  method: "POST",
  path: "/repos/{owner}/{repo}/issues",
  params: [
    { name: "owner", in: "path", type: "string", required: true },
    { name: "repo", in: "path", type: "string", required: true },
    { name: "payload", in: "body", type: "string", required: true },
  ],
}

describe("HttpConnectionSchema", () => {
  it("round-trips a valid connection (GET path+query tool, POST body tool)", () => {
    const result = HttpConnectionSchema.safeParse({
      baseUrl: "https://api.github.com",
      tools: [getIssueTool, createIssueTool],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tools).toHaveLength(2)
      expect(result.data.tools[0]?.method).toBe("GET")
      expect(result.data.tools[1]?.method).toBe("POST")
    }
  })

  it("parses an apiKey auth connection", () => {
    const result = HttpConnectionSchema.safeParse({
      baseUrl: "https://api.example.com",
      auth: { scheme: "apiKey", in: "header", name: "X-API-Key" },
      tools: [getIssueTool],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.auth?.scheme).toBe("apiKey")
    }
  })

  it("parses a bearer auth connection", () => {
    const result = HttpConnectionSchema.safeParse({
      baseUrl: "https://api.example.com",
      auth: { scheme: "bearer" },
      tools: [getIssueTool],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.auth?.scheme).toBe("bearer")
    }
  })

  it("rejects a connection with zero tools", () => {
    const result = HttpConnectionSchema.safeParse({
      baseUrl: "https://api.example.com",
      tools: [],
    })
    expect(result.success).toBe(false)
  })
})

describe("HttpRequestToolSchema — path↔param cross-check refine", () => {
  it('accepts a tool whose path placeholders exactly match its in:"path" params', () => {
    const r = HttpRequestToolSchema.safeParse(getIssueTool)
    expect(r.success).toBe(true)
  })

  it('REJECTS a {placeholder} in path with no matching in:"path" param', () => {
    // "repo" placeholder has no declared param at all.
    const r = HttpRequestToolSchema.safeParse({
      name: "listIssues",
      description: "List issues",
      method: "GET",
      path: "/repos/{owner}/{repo}/issues",
      params: [{ name: "owner", in: "path", type: "string", required: true }],
    })
    expect(r.success).toBe(false)
  })

  it('REJECTS an in:"path" param that does not appear as a {placeholder} in path', () => {
    // "repo" is declared in:"path" but the path template has no {repo}.
    const r = HttpRequestToolSchema.safeParse({
      name: "listIssues",
      description: "List issues",
      method: "GET",
      path: "/repos/{owner}/issues",
      params: [
        { name: "owner", in: "path", type: "string", required: true },
        { name: "repo", in: "path", type: "string", required: true },
      ],
    })
    expect(r.success).toBe(false)
  })

  it("neutering the cross-check would let a mismatched path/param slip through — sanity control", () => {
    // Positive control: the SAME params list, but with a path that DOES match,
    // parses fine — proving the refine (not some other field) is what rejects above.
    const r = HttpRequestToolSchema.safeParse({
      name: "listIssues",
      description: "List issues",
      method: "GET",
      path: "/repos/{owner}/{repo}/issues",
      params: [
        { name: "owner", in: "path", type: "string", required: true },
        { name: "repo", in: "path", type: "string", required: true },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('REJECTS an optional in:"path" param (a {placeholder} is structurally mandatory)', () => {
    // inc-30.7 SSRF review: an optional in:"path" param omitted by the agent would
    // leave a literal "{owner}" in the outbound URL — reject at the boundary.
    const r = HttpRequestToolSchema.safeParse({
      name: "getIssue",
      description: "Get issue",
      method: "GET",
      path: "/repos/{owner}",
      params: [{ name: "owner", in: "path", type: "string", required: false }],
    })
    expect(r.success).toBe(false)
  })

  it('accepts a required in:"path" param (the normal case)', () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "getIssue",
      description: "Get issue",
      method: "GET",
      path: "/repos/{owner}",
      params: [{ name: "owner", in: "path", type: "string", required: true }],
    })
    expect(r.success).toBe(true)
  })

  it("allows an optional query param (only path params are forced required)", () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "search",
      description: "Search",
      method: "GET",
      path: "/search",
      params: [{ name: "sort", in: "query", type: "string", required: false }],
    })
    expect(r.success).toBe(true)
  })

  it("REJECTS a repeated {placeholder} in the path (can't bind past the first)", () => {
    // inc-30.7 correctness review: /a/{id}/b/{id} — .replace binds only the first.
    const r = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "d",
      method: "GET",
      path: "/a/{id}/b/{id}",
      params: [{ name: "id", in: "path", type: "string", required: true }],
    })
    expect(r.success).toBe(false)
  })

  it('REJECTS an in:"body" param on a GET tool (fetch throws on GET+body)', () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "d",
      method: "GET",
      path: "/x",
      params: [{ name: "q", in: "body", type: "string", required: false }],
    })
    expect(r.success).toBe(false)
  })

  it('accepts an in:"body" param on a POST tool', () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "d",
      method: "POST",
      path: "/x",
      params: [{ name: "payload", in: "body", type: "string", required: true }],
    })
    expect(r.success).toBe(true)
  })

  it("REJECTS duplicate param names across different locations (dual-bind collision)", () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "d",
      method: "GET",
      path: "/x/{id}",
      params: [
        { name: "id", in: "path", type: "string", required: true },
        { name: "id", in: "query", type: "string", required: false },
      ],
    })
    expect(r.success).toBe(false)
  })

  // inc-30.7 CodeRabbit review fixes
  it("REJECTS an empty-string description", () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "",
      method: "GET",
      path: "/x",
      params: [],
    })
    expect(r.success).toBe(false)
  })

  it("accepts a hyphenated query/header param name (X-Api-Key), rejects it for a path param", () => {
    const header = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "d",
      method: "GET",
      path: "/x",
      params: [{ name: "X-Api-Key", in: "header", type: "string", required: false }],
    })
    expect(header.success).toBe(true)
    // a hyphenated name is invalid for a path param (interpolates into the URL)
    const path = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "d",
      method: "GET",
      path: "/x/{my-id}",
      params: [{ name: "my-id", in: "path", type: "string", required: true }],
    })
    expect(path.success).toBe(false)
  })

  it('REJECTS a non-body param named "body" (reserved for the request body)', () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "d",
      method: "GET",
      path: "/x",
      params: [{ name: "body", in: "query", type: "string", required: false }],
    })
    expect(r.success).toBe(false)
  })

  it("REJECTS a nested-quantifier pattern (ReDoS shape) at author-time", () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "d",
      method: "GET",
      path: "/x",
      params: [
        {
          name: "q",
          in: "query",
          type: "string",
          required: false,
          pattern: "(a+)+",
          maxLength: 64,
        },
      ],
    })
    expect(r.success).toBe(false)
  })

  it("accepts a benign pattern with maxLength", () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "t",
      description: "d",
      method: "GET",
      path: "/x",
      params: [
        {
          name: "q",
          in: "query",
          type: "string",
          required: false,
          pattern: "[a-z0-9]+",
          maxLength: 64,
        },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('REJECTS more than one in:"body" param', () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "createIssue",
      description: "Create an issue",
      method: "POST",
      path: "/repos/{owner}/issues",
      params: [
        { name: "owner", in: "path", type: "string", required: true },
        { name: "title", in: "body", type: "string", required: true },
        { name: "body", in: "body", type: "string", required: true },
      ],
    })
    expect(r.success).toBe(false)
  })

  it('accepts exactly one in:"body" param', () => {
    const r = HttpRequestToolSchema.safeParse(createIssueTool)
    expect(r.success).toBe(true)
  })

  it("requires a non-empty description (not optional)", () => {
    const r = HttpRequestToolSchema.safeParse({
      name: "listIssues",
      method: "GET",
      path: "/repos",
      params: [],
    })
    expect(r.success).toBe(false)
  })
})

describe("HttpParamSchema — enum/pattern refines", () => {
  it('REJECTS type:"enum" without a non-empty enum array', () => {
    const r = HttpParamSchema.safeParse({ name: "state", in: "query", type: "enum" })
    expect(r.success).toBe(false)
  })

  it('accepts type:"enum" with a non-empty enum array', () => {
    const r = HttpParamSchema.safeParse({
      name: "state",
      in: "query",
      type: "enum",
      enum: ["open", "closed"],
    })
    expect(r.success).toBe(true)
  })

  it("REJECTS pattern without maxLength (ReDoS guard)", () => {
    const r = HttpParamSchema.safeParse({
      name: "id",
      in: "path",
      type: "string",
      pattern: "[0-9]+",
    })
    expect(r.success).toBe(false)
  })

  it("accepts pattern with maxLength", () => {
    const r = HttpParamSchema.safeParse({
      name: "id",
      in: "path",
      type: "string",
      pattern: "[0-9]+",
      maxLength: 32,
    })
    expect(r.success).toBe(true)
  })
})

describe('PlatformSchema — kind:"http"', () => {
  it('parses a platform with kind:"http" and a valid http connection', () => {
    const result = PlatformSchema.safeParse({
      id: "github-rest",
      kind: "http",
      displayName: "GitHub REST",
      http: {
        baseUrl: "https://api.github.com",
        tools: [getIssueTool],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.kind).toBe("http")
      expect(result.data.http?.tools).toHaveLength(1)
    }
  })
})
