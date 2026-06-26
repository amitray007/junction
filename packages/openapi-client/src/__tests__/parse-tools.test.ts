// SPDX-License-Identifier: AGPL-3.0-only
// Tests for spec parsing + tool extraction (including selection filtering).
// Uses an inline spec (no network) per docs/rules/testing.md.

import { describe, expect, it } from "vitest"
import { parseSpec } from "../parse.js"
import { extractTools, operationMatchesSelection } from "../tools.js"

// ---------------------------------------------------------------------------
// Minimal 3-operation spec (inline)
// ---------------------------------------------------------------------------

const INLINE_SPEC = {
  openapi: "3.0.3",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "http://localhost:9999" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List all pets",
        parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer" } }],
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/pets/{petId}": {
      get: {
        // No operationId — should use method_path fallback
        summary: "Get a pet by ID",
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
}

// Spec with a nullable field
const NULLABLE_SPEC = {
  openapi: "3.0.3",
  info: { title: "Nullable API", version: "1.0.0" },
  paths: {
    "/thing": {
      get: {
        operationId: "getThing",
        parameters: [{ name: "val", in: "query", schema: { type: "string", nullable: true } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
}

describe("parseSpec (inline)", () => {
  it("parses a valid 3-operation spec", async () => {
    const result = await parseSpec({ from: "inline", document: INLINE_SPEC })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.schema).toBeDefined()
    expect(result.value.schema.paths).toBeDefined()
  })

  it("returns spec-parse-failed for an invalid doc", async () => {
    const result = await parseSpec({ from: "inline", document: { not: "an-openapi-doc" } })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("spec-parse-failed")
  })
})

describe("extractTools", () => {
  it("extracts 3 tools from the 3-operation spec", async () => {
    const specResult = await parseSpec({ from: "inline", document: INLINE_SPEC })
    expect(specResult.isOk()).toBe(true)
    if (!specResult.isOk()) return

    const result = extractTools(specResult.value.schema)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const tools = result.value
    expect(tools).toHaveLength(3)

    const names = tools.map((t) => t.name)
    expect(names).toContain("listPets")
    expect(names).toContain("createPet")
    // No operationId → method_path derived
    expect(names.some((n) => n.startsWith("get_pets_"))).toBe(true)
  })

  it("uses operationId for description", async () => {
    const specResult = await parseSpec({ from: "inline", document: INLINE_SPEC })
    if (!specResult.isOk()) return
    const result = extractTools(specResult.value.schema)
    if (!result.isOk()) return

    const listPets = result.value.find((t) => t.name === "listPets")
    expect(listPets?.description).toBe("List all pets")
  })

  it("merges path+query params and requestBody into inputSchema", async () => {
    const specResult = await parseSpec({ from: "inline", document: INLINE_SPEC })
    if (!specResult.isOk()) return
    const result = extractTools(specResult.value.schema)
    if (!result.isOk()) return

    const createPet = result.value.find((t) => t.name === "createPet")
    expect(createPet).toBeDefined()
    const schema = createPet?.inputSchema as Record<string, unknown>
    expect(schema.type).toBe("object")
    const props = schema.properties as Record<string, unknown>
    expect(props.body).toBeDefined()
    expect((schema.required as string[]).includes("body")).toBe(true)
  })

  it("normalizes nullable:true → type:[string,null]", async () => {
    const specResult = await parseSpec({ from: "inline", document: NULLABLE_SPEC })
    if (!specResult.isOk()) return
    const result = extractTools(specResult.value.schema)
    if (!result.isOk()) return

    const getThing = result.value.find((t) => t.name === "getThing")
    expect(getThing).toBeDefined()
    const schema = getThing?.inputSchema as Record<string, unknown>
    const props = schema.properties as Record<string, unknown>
    const valSchema = props.val as Record<string, unknown>
    expect(Array.isArray(valSchema.type)).toBe(true)
    expect((valSchema.type as string[]).includes("null")).toBe(true)
    expect(valSchema.nullable).toBeUndefined()
  })

  it("returns too-many-tools when cap exceeded", async () => {
    const specResult = await parseSpec({ from: "inline", document: INLINE_SPEC })
    if (!specResult.isOk()) return

    const result = extractTools(specResult.value.schema, 2) // cap=2, spec has 3 ops
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("too-many-tools")
    if (result.error.kind !== "too-many-tools") return
    expect(result.error.count).toBe(3)
    expect(result.error.cap).toBe(2)
  })

  it("deduplicates name collisions with _2 suffix", async () => {
    // Two operations with the same operationId (sanitized) would collide
    const collisionSpec = {
      openapi: "3.0.3",
      info: { title: "Collision API", version: "1.0.0" },
      paths: {
        "/a": { get: { operationId: "doThing", responses: {} } },
        "/b": { get: { operationId: "doThing", responses: {} } },
      },
    }
    const specResult = await parseSpec({ from: "inline", document: collisionSpec })
    if (!specResult.isOk()) return
    const result = extractTools(specResult.value.schema)
    if (!result.isOk()) return

    const names = result.value.map((t) => t.name)
    expect(names).toContain("doThing")
    expect(names).toContain("doThing_2")
  })
})

// ---------------------------------------------------------------------------
// Spec used for selection tests — 6 operations across 3 tags + 1 untagged
// ---------------------------------------------------------------------------

// pet×3 (/pet GET+POST, /pet/{petId} GET), store×1, user×1, untagged×1
const TAGGED_SPEC = {
  openapi: "3.0.3",
  info: { title: "Tagged API", version: "1.0.0" },
  paths: {
    "/pet": {
      get: {
        operationId: "listPets",
        tags: ["pet"],
        summary: "List pets",
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createPet",
        tags: ["pet"],
        summary: "Create pet",
        responses: { "201": { description: "created" } },
      },
    },
    "/pet/{petId}": {
      get: {
        operationId: "getPet",
        tags: ["pet"],
        summary: "Get pet",
        responses: { "200": { description: "ok" } },
      },
    },
    "/store/inventory": {
      get: {
        operationId: "getInventory",
        tags: ["store"],
        summary: "Get inventory",
        responses: { "200": { description: "ok" } },
      },
    },
    "/user": {
      post: {
        operationId: "createUser",
        tags: ["user"],
        summary: "Create user",
        responses: { "201": { description: "created" } },
      },
    },
    "/noop": {
      get: {
        operationId: "noopGet",
        // no tags — untagged operation
        summary: "Untagged op",
        responses: { "200": { description: "ok" } },
      },
    },
  },
} as Record<string, unknown>

// ---------------------------------------------------------------------------
// operationMatchesSelection — edge cases
// ---------------------------------------------------------------------------

describe("operationMatchesSelection", () => {
  it("absent select (both arrays undefined) → true for any operation", () => {
    expect(operationMatchesSelection("/pet", { operationId: "x", tags: ["pet"] }, {})).toBe(true)
  })

  it("empty arrays → true for any operation", () => {
    expect(
      operationMatchesSelection(
        "/pet",
        { operationId: "x", tags: ["pet"] },
        { tags: [], paths: [] },
      ),
    ).toBe(true)
  })

  it("tag match: operation tag in select.tags → true", () => {
    expect(operationMatchesSelection("/pet", { tags: ["pet", "v2"] }, { tags: ["pet"] })).toBe(true)
  })

  it("tag match: no intersection → false", () => {
    expect(
      operationMatchesSelection("/store/inventory", { tags: ["store"] }, { tags: ["pet"] }),
    ).toBe(false)
  })

  it("tag match: untagged op with tags filter → false", () => {
    expect(operationMatchesSelection("/noop", { operationId: "noopGet" }, { tags: ["pet"] })).toBe(
      false,
    )
  })

  it("path match: exact prefix → true", () => {
    expect(operationMatchesSelection("/pet", { operationId: "x" }, { paths: ["/pet"] })).toBe(true)
  })

  it("path match: nested path → true", () => {
    expect(
      operationMatchesSelection("/pet/{petId}", { operationId: "x" }, { paths: ["/pet"] }),
    ).toBe(true)
  })

  it("path /pet does NOT match /pets — path-boundary prefix", () => {
    // '/pets'.startsWith('/pet') is true, but '/pets'[4] === 's' ≠ '/', so no match
    expect(operationMatchesSelection("/pets", { operationId: "x" }, { paths: ["/pet"] })).toBe(
      false,
    )
  })

  it("tag + path union: matches if EITHER criterion hits", () => {
    // tags=["store"], path=["/user"] — /store/inventory matches by tag, /user by path
    expect(
      operationMatchesSelection(
        "/store/inventory",
        { tags: ["store"] },
        { tags: ["store"], paths: ["/user"] },
      ),
    ).toBe(true)
    expect(
      operationMatchesSelection("/user", { tags: ["user"] }, { tags: ["store"], paths: ["/user"] }),
    ).toBe(true)
    // /pet/123 has pet tag — doesn't match store tag or /user path prefix
    expect(
      operationMatchesSelection(
        "/pet/123",
        { tags: ["pet"] },
        { tags: ["store"], paths: ["/user"] },
      ),
    ).toBe(false)
  })

  it("multiple tags filter — matches any listed tag", () => {
    expect(operationMatchesSelection("/pet", { tags: ["pet"] }, { tags: ["pet", "store"] })).toBe(
      true,
    )
    expect(
      operationMatchesSelection(
        "/store/inventory",
        { tags: ["store"] },
        { tags: ["pet", "store"] },
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// extractTools — selection parameter
// ---------------------------------------------------------------------------

describe("extractTools — selection", () => {
  it("no select → all operations included (6)", () => {
    const result = extractTools(TAGGED_SPEC)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.length).toBe(6)
  })

  it("empty select (both absent) → all operations", () => {
    const result = extractTools(TAGGED_SPEC, 75, {})
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.length).toBe(6)
  })

  it("tag-only filter → only pet operations (3)", () => {
    const result = extractTools(TAGGED_SPEC, 75, { tags: ["pet"] })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const names = result.value.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(["listPets", "createPet", "getPet"]))
    expect(names).not.toContain("getInventory")
    expect(names).not.toContain("createUser")
    expect(names).not.toContain("noopGet")
    expect(result.value.length).toBe(3)
  })

  it("path-prefix filter → /pet and /pet/{petId} only (3)", () => {
    const result = extractTools(TAGGED_SPEC, 75, { paths: ["/pet"] })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const names = result.value.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(["listPets", "createPet", "getPet"]))
    expect(names).not.toContain("getInventory")
    expect(result.value.length).toBe(3)
  })

  it("tag + path union → store + user (2)", () => {
    const result = extractTools(TAGGED_SPEC, 75, { tags: ["store"], paths: ["/user"] })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const names = result.value.map((t) => t.name)
    expect(names).toContain("getInventory")
    expect(names).toContain("createUser")
    expect(names).not.toContain("listPets")
    expect(result.value.length).toBe(2)
  })

  it("selected count (3 pet) under cap=4 passes while full count (6) is over cap=4", () => {
    const result = extractTools(TAGGED_SPEC, 4, { tags: ["pet"] })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.length).toBe(3)
  })

  it("full count (6) over cap=4 without selection → too-many-tools", () => {
    const result = extractTools(TAGGED_SPEC, 4)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("too-many-tools")
    if (result.error.kind !== "too-many-tools") return
    expect(result.error.count).toBe(6)
    expect(result.error.cap).toBe(4)
  })

  it("untagged op excluded when tag filter is active", () => {
    const result = extractTools(TAGGED_SPEC, 75, { tags: ["pet"] })
    if (!result.isOk()) return
    expect(result.value.map((t) => t.name)).not.toContain("noopGet")
  })

  it("non-matching tag/path excluded", () => {
    const result = extractTools(TAGGED_SPEC, 75, { tags: ["unknown-tag"] })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.length).toBe(0)
  })
})
