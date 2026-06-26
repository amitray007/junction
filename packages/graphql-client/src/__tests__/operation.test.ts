// SPDX-License-Identifier: AGPL-3.0-only
// Operation-type enforcement tests — the load-bearing novelty of the graphql provider.
// Covers: query/mutation split, subscription rejection, operationName selection,
// syntax errors, and multi-op doc disambiguation.

import { describe, expect, it } from "vitest"
import { assertOperationType, getOperationType } from "../operation.js"

// ---------------------------------------------------------------------------
// getOperationType
// ---------------------------------------------------------------------------

describe("getOperationType", () => {
  it("returns 'query' for a bare query operation", () => {
    const result = getOperationType("{ viewer { login } }", undefined)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toBe("query")
  })

  it("returns 'query' for an explicit query keyword", () => {
    const result = getOperationType("query GetViewer { viewer { login } }", undefined)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toBe("query")
  })

  it("returns 'mutation' for a mutation operation", () => {
    const result = getOperationType(
      "mutation CreateIssue($title: String!) { createIssue(input:{title:$title}) { issue { id } } }",
      undefined,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toBe("mutation")
  })

  it("returns 'subscription' for a subscription operation", () => {
    const result = getOperationType("subscription OnNewMessage { messageAdded { id } }", undefined)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toBe("subscription")
  })

  it("returns invalid-args on a syntax error", () => {
    const result = getOperationType("{ unclosed", undefined)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("invalid-args")
      expect(result.error.reason).toContain("syntax error")
    }
  })

  it("returns invalid-args for empty document", () => {
    const result = getOperationType("", undefined)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("invalid-args")
  })

  it("selects operation by operationName in a multi-op doc", () => {
    const doc = `
      query GetUser { viewer { login } }
      mutation UpdateUser { updateUser(id:"1") { id } }
    `
    const qResult = getOperationType(doc, "GetUser")
    expect(qResult.isOk()).toBe(true)
    if (qResult.isOk()) expect(qResult.value).toBe("query")

    const mResult = getOperationType(doc, "UpdateUser")
    expect(mResult.isOk()).toBe(true)
    if (mResult.isOk()) expect(mResult.value).toBe("mutation")
  })

  it("returns invalid-args when operationName not found in multi-op doc", () => {
    const doc = "query A { viewer { login } } query B { viewer { login } }"
    const result = getOperationType(doc, "Missing")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("invalid-args")
      expect(result.error.reason).toContain("Missing")
    }
  })

  it("returns invalid-args for multi-op doc without operationName", () => {
    const doc = "query A { viewer { login } } query B { viewer { login } }"
    const result = getOperationType(doc, undefined)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("invalid-args")
  })
})

// ---------------------------------------------------------------------------
// assertOperationType — the enforcement gate for graphql_query / graphql_mutation
// ---------------------------------------------------------------------------

describe("assertOperationType — graphql_query (expected: query)", () => {
  it("accepts a query operation", () => {
    const result = assertOperationType("{ viewer { login } }", undefined, "query")
    expect(result.isOk()).toBe(true)
  })

  it("rejects a mutation sent to graphql_query", () => {
    const result = assertOperationType(
      "mutation CreateIssue { createIssue { id } }",
      undefined,
      "query",
    )
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("invalid-args")
      expect(result.error.reason).toContain("mutation")
      expect(result.error.reason).toContain("graphql_mutation")
    }
  })

  it("rejects a subscription sent to graphql_query", () => {
    const result = assertOperationType(
      "subscription OnMsg { messageAdded { id } }",
      undefined,
      "query",
    )
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("invalid-args")
      expect(result.error.reason).toContain("subscription")
    }
  })

  it("rejects a syntax error", () => {
    const result = assertOperationType("{ unclosed", undefined, "query")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("invalid-args")
  })

  it("uses operationName to select from a multi-op doc (query branch)", () => {
    const doc =
      'query GetUser { viewer { login } } mutation UpdateUser { updateUser(id:"1") { id } }'
    const result = assertOperationType(doc, "GetUser", "query")
    expect(result.isOk()).toBe(true)
  })
})

describe("assertOperationType — graphql_mutation (expected: mutation)", () => {
  it("accepts a mutation operation", () => {
    const result = assertOperationType(
      "mutation CreateIssue { createIssue { id } }",
      undefined,
      "mutation",
    )
    expect(result.isOk()).toBe(true)
  })

  it("rejects a query sent to graphql_mutation", () => {
    const result = assertOperationType("{ viewer { login } }", undefined, "mutation")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("invalid-args")
      expect(result.error.reason).toContain("query")
      expect(result.error.reason).toContain("graphql_query")
    }
  })

  it("rejects a subscription sent to graphql_mutation", () => {
    const result = assertOperationType(
      "subscription OnMsg { messageAdded { id } }",
      undefined,
      "mutation",
    )
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("invalid-args")
      expect(result.error.reason).toContain("subscription")
    }
  })

  it("uses operationName to select from a multi-op doc (mutation branch)", () => {
    const doc =
      'query GetUser { viewer { login } } mutation UpdateUser { updateUser(id:"1") { id } }'
    const result = assertOperationType(doc, "UpdateUser", "mutation")
    expect(result.isOk()).toBe(true)
  })
})
