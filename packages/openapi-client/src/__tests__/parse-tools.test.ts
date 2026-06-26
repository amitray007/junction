// SPDX-License-Identifier: AGPL-3.0-only
// Tests for spec parsing + tool extraction.
// Uses an inline spec (no network) per docs/rules/testing.md.

import { describe, expect, it } from "vitest"
import { parseSpec } from "../parse.js"
import { extractTools } from "../tools.js"

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
