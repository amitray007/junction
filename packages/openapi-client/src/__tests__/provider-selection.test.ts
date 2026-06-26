// SPDX-License-Identifier: AGPL-3.0-only
// Tests that connection.select is enforced at runtime (not just at add-time).
//
// The load-bearing invariant: the runtime provider re-extracts tools from the full
// cached spec on every listTools call. If selection were only applied at add-time,
// the full over-cap set would leak through listTools. These tests prove that a
// connection with `select` exposes ONLY the persisted slice at serve/probe time.

import { describe, expect, it } from "vitest"
import { createOpenApiProvider } from "../provider.js"

// Spec: 5 operations across 3 tags (pet×3, store×1, user×1)
const MULTI_TAG_SPEC = {
  openapi: "3.0.3",
  info: { title: "Multi-Tag API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
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
        summary: "Get pet by ID",
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
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
  },
}

describe("createOpenApiProvider — selection enforced at runtime (listTools)", () => {
  it("connection with select.tags lists ONLY the selected tools — not the full spec set", async () => {
    // This test proves the runtime enforcement: even though the spec has 5 ops,
    // a provider with select={tags:["pet"]} must return only the 3 pet ops.
    const provider = createOpenApiProvider(
      {
        spec: { from: "inline", document: MULTI_TAG_SPEC },
        baseUrl: "https://api.example.com",
        select: { tags: ["pet"] },
      },
      null,
    )

    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const names = result.value.map((t) => t.name)
    expect(names).toContain("listPets")
    expect(names).toContain("createPet")
    expect(names).toContain("getPet")
    // store + user operations MUST NOT appear
    expect(names).not.toContain("getInventory")
    expect(names).not.toContain("createUser")
    expect(result.value.length).toBe(3)
  })

  it("connection with no selection lists all 5 tools", async () => {
    const provider = createOpenApiProvider(
      {
        spec: { from: "inline", document: MULTI_TAG_SPEC },
        baseUrl: "https://api.example.com",
      },
      null,
    )

    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.length).toBe(5)
  })

  it("connection with select.paths lists only ops under the path prefix", async () => {
    const provider = createOpenApiProvider(
      {
        spec: { from: "inline", document: MULTI_TAG_SPEC },
        baseUrl: "https://api.example.com",
        select: { paths: ["/pet"] },
      },
      null,
    )

    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const names = result.value.map((t) => t.name)
    // /pet and /pet/{petId} match the /pet prefix; /store/inventory and /user do not
    expect(names).toContain("listPets")
    expect(names).toContain("createPet")
    expect(names).toContain("getPet")
    expect(names).not.toContain("getInventory")
    expect(names).not.toContain("createUser")
    expect(result.value.length).toBe(3)
  })

  it("select on full-over-cap spec returns just the selected slice", async () => {
    // Spec with 5 ops; cap=3 — adding without selection would fail.
    // With select.tags=["pet"], 3 ops ≤ 3 → ok.
    const provider = createOpenApiProvider(
      {
        spec: { from: "inline", document: MULTI_TAG_SPEC },
        baseUrl: "https://api.example.com",
        maxTools: 3,
        select: { tags: ["pet"] },
      },
      null,
    )

    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.length).toBe(3)
    expect(result.value.map((t) => t.name)).toEqual(
      expect.arrayContaining(["listPets", "createPet", "getPet"]),
    )
  })
})
