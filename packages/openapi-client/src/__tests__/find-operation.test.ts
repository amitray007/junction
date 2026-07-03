// SPDX-License-Identifier: AGPL-3.0-only
// Tests for findOperationByOperationId + hasAmbiguousSanitizedName — the
// add-time verifyOperationId validation helpers (increment 28.9, correctness
// review fixes 2(b) and 6). Uses inline schemas (no network) per docs/rules/testing.md.

import { describe, expect, it } from "vitest"
import { findOperationByOperationId, hasAmbiguousSanitizedName } from "../tools.js"

describe("findOperationByOperationId — path-item-level required params (fix 6)", () => {
  it("counts a required parameter declared on the operation itself", () => {
    const schema = {
      paths: {
        "/pets/{petId}": {
          get: {
            operationId: "getPet",
            parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
          },
        },
      },
    }
    const found = findOperationByOperationId(schema, "getPet")
    expect(found).not.toBeNull()
    expect(found?.hasRequiredParameter).toBe(true)
  })

  it("counts a required parameter declared ONLY at the enclosing path-item level", () => {
    const schema = {
      paths: {
        "/orgs/{orgId}": {
          parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getOrg",
            // No operation-level `parameters` at all — orgId is inherited.
          },
        },
      },
    }
    const found = findOperationByOperationId(schema, "getOrg")
    expect(found).not.toBeNull()
    expect(found?.hasRequiredParameter).toBe(true)
  })

  it("false when neither the operation nor the path-item declares a required param", () => {
    const schema = {
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            parameters: [
              { name: "limit", in: "query", required: false, schema: { type: "integer" } },
            ],
          },
        },
      },
    }
    const found = findOperationByOperationId(schema, "listPets")
    expect(found).not.toBeNull()
    expect(found?.hasRequiredParameter).toBe(false)
  })

  it("returns null when the operationId doesn't exist in the spec", () => {
    const schema = { paths: { "/pets": { get: { operationId: "listPets" } } } }
    expect(findOperationByOperationId(schema, "doesNotExist")).toBeNull()
  })
})

describe("hasAmbiguousSanitizedName — verifyOperationId collision check (fix 2b)", () => {
  it("true when another operation's raw operationId sanitizes to the same tool name", () => {
    const schema = {
      paths: {
        "/users/me": { get: { operationId: "users.me" } },
        "/users/me-alias": { get: { operationId: "users_me" } },
      },
    }
    // Both "users.me" and "users_me" sanitize to "users_me".
    expect(hasAmbiguousSanitizedName(schema, "users_me")).toBe(true)
    expect(hasAmbiguousSanitizedName(schema, "users.me")).toBe(true)
  })

  it("false when no other operation collides after sanitization", () => {
    const schema = {
      paths: {
        "/orders/mine": { get: { operationId: "orders.mine" } },
        "/pets": { get: { operationId: "listPets" } },
      },
    }
    expect(hasAmbiguousSanitizedName(schema, "orders.mine")).toBe(false)
  })

  it("false when the schema has only one operation (nothing to collide with)", () => {
    const schema = { paths: { "/pets": { get: { operationId: "listPets" } } } }
    expect(hasAmbiguousSanitizedName(schema, "listPets")).toBe(false)
  })
})
