// SPDX-License-Identifier: AGPL-3.0-only
// addOpenApiPlatform tests. parseSpec only accepts {from:"url"|"file"|"inline"} — this
// package's addOpenApiPlatform hardcodes {from:"url"}, so a local http server stands in
// for the spec host (keeps the test I/O-light while exercising the real fetch path).

import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { addOpenApiPlatform } from "../openapi.js"

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "http://localhost:9999" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List all pets",
        tags: ["pets"],
        responses: { "200": { description: "ok" } },
      },
    },
    "/store": {
      get: {
        operationId: "listStore",
        summary: "List store items",
        tags: ["store"],
        responses: { "200": { description: "ok" } },
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        summary: "Get a pet by id",
        tags: ["pets"],
        // Operation-level parameter (used by the "GET with a required param
        // is rejected" verifyOperationId test below).
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
      delete: {
        operationId: "deletePet",
        summary: "Delete a pet",
        tags: ["pets"],
        // OpenAPI requires every {petId} template var to be declared at
        // either the path-item or the operation level — declare it here too
        // (used by the "non-GET is rejected" verifyOperationId test below).
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "no content" } },
      },
    },
    // A dotted operationId whose sanitized name is UNIQUE in the spec — validates
    // fine at add time, but the runtime call path matches SANITIZED tool names
    // ("." → "_"). Covers the fix-2 dotted-id end-to-end regression (add-time
    // passes; the source-runtime verify call sanitizes before calling, tested
    // separately in source-runtime).
    "/orders/mine": {
      get: {
        operationId: "orders.mine",
        summary: "Get my orders",
        tags: ["users"],
        responses: { "200": { description: "ok" } },
      },
    },
    // Two operations whose RAW operationIds are distinct but sanitize to the
    // SAME tool name — "users_me" (the dotted "users.me" sanitizes to
    // "users_me") and a raw "users_me" here. Designating either as
    // verifyOperationId is ambiguous: extractTools' dedup would suffix
    // whichever comes second, and the runtime verify call
    // (sanitizeOperationId(verifyOperationId)) could bind to either.
    "/users/me": {
      get: {
        operationId: "users.me",
        summary: "Get the current user",
        tags: ["users"],
        responses: { "200": { description: "ok" } },
      },
    },
    "/users/me-alias": {
      get: {
        operationId: "users_me",
        summary: "Get the current user (alias)",
        tags: ["users"],
        responses: { "200": { description: "ok" } },
      },
    },
    // A required parameter declared at the PATH-ITEM level (inherited by every
    // operation under this path), not on the operation itself — covers fix 6.
    "/orgs/{orgId}": {
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "getOrg",
        summary: "Get an org by id",
        tags: ["orgs"],
        responses: { "200": { description: "ok" } },
      },
    },
  },
}

let baseUrl: string
let server: ReturnType<typeof createServer>
let junctionHome: string
const savedJunctionHome = process.env.JUNCTION_HOME

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/does-not-exist.json") {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(SPEC))
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://localhost:${port}`

  junctionHome = await mkdtemp(path.join(os.tmpdir(), "jx-po-test-"))
  process.env.JUNCTION_HOME = junctionHome
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(junctionHome, { recursive: true, force: true })
  if (savedJunctionHome === undefined) delete process.env.JUNCTION_HOME
  else process.env.JUNCTION_HOME = savedJunctionHome
})

afterEach(() => {
  process.env.JUNCTION_HOME = junctionHome
})

describe("addOpenApiPlatform", () => {
  it("assembles a Platform, extracts tools, and caches the spec", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore",
      displayName: "Petstore",
      specUrl: `${baseUrl}/openapi.json`,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.platform.kind).toBe("openapi")
    expect(result.value.toolCount).toBe(8)
    expect(result.value.platform.openapi?.baseUrl).toBe("http://localhost:9999")
    expect(result.value.cacheFile).toContain("petstore")
  })

  it("respects a --tag select filter", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-pets",
      displayName: "Petstore (pets only)",
      specUrl: `${baseUrl}/openapi.json`,
      select: { tags: ["pets"] },
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.toolCount).toBe(3)
  })

  it("too-many-tools returns the tag breakdown", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-cap",
      displayName: "Petstore (capped)",
      specUrl: `${baseUrl}/openapi.json`,
      maxTools: 1,
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("too-many-tools")
    if (result.error.kind !== "too-many-tools") return
    expect(result.error.count).toBe(8)
    expect(result.error.cap).toBe(1)
    expect(result.error.tagCounts).toEqual(
      expect.arrayContaining([
        { tag: "pets", count: 3 },
        { tag: "store", count: 1 },
        { tag: "users", count: 3 },
        { tag: "orgs", count: 1 },
      ]),
    )
  })

  it("applies a caller-provided auth override instead of deriving from the spec", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-auth",
      displayName: "Petstore (auth)",
      specUrl: `${baseUrl}/openapi.json`,
      auth: { scheme: "bearer" },
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.platform.openapi?.auth).toEqual({
      scheme: "bearer",
      header: "Authorization",
    })
  })

  it("spec fetch failure returns spec-fetch-failed", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-404",
      displayName: "Petstore (missing)",
      specUrl: `${baseUrl}/does-not-exist.json`,
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("spec-fetch-failed")
  })
})

// ---------------------------------------------------------------------------
// verifyOperationId — verify-on-add (increment 28.9). Must resolve to a GET
// with no required parameters; else the platform-add call fails cleanly.
// ---------------------------------------------------------------------------

describe("addOpenApiPlatform — verifyOperationId validation", () => {
  it("a valid GET-with-no-required-params operationId is accepted and persisted", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-verify-ok",
      displayName: "Petstore (verify ok)",
      specUrl: `${baseUrl}/openapi.json`,
      verifyOperationId: "listPets",
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.platform.openapi?.verifyOperationId).toBe("listPets")
  })

  it("a POST/DELETE (non-GET) operationId is rejected", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-verify-post",
      displayName: "Petstore (verify post)",
      specUrl: `${baseUrl}/openapi.json`,
      verifyOperationId: "deletePet",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("verify-op-invalid")
    if (result.error.kind !== "verify-op-invalid") return
    expect(result.error.message).toContain("DELETE")
  })

  it("a GET operationId with a required parameter is rejected", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-verify-required-param",
      displayName: "Petstore (verify required param)",
      specUrl: `${baseUrl}/openapi.json`,
      verifyOperationId: "getPet",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("verify-op-invalid")
    if (result.error.kind !== "verify-op-invalid") return
    expect(result.error.message).toContain("required parameters")
  })

  it("an unknown operationId is rejected", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-verify-unknown",
      displayName: "Petstore (verify unknown)",
      specUrl: `${baseUrl}/openapi.json`,
      verifyOperationId: "doesNotExist",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("verify-op-invalid")
    if (result.error.kind !== "verify-op-invalid") return
    expect(result.error.message).toContain("not found")
  })

  it("absent verifyOperationId leaves the field undefined on the connection descriptor", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-verify-absent",
      displayName: "Petstore (verify absent)",
      specUrl: `${baseUrl}/openapi.json`,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.platform.openapi?.verifyOperationId).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // fix 2 — a dotted operationId (its sanitized tool name is unambiguous)
  // passes add-time validation; the sanitization itself happens on the
  // runtime verify call path (covered end-to-end in source-runtime's
  // verify-credential.test.ts).
  // -------------------------------------------------------------------------

  it("a dotted operationId whose sanitized name is unambiguous is accepted", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-verify-dotted",
      displayName: "Petstore (verify dotted)",
      specUrl: `${baseUrl}/openapi.json`,
      verifyOperationId: "orders.mine",
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.platform.openapi?.verifyOperationId).toBe("orders.mine")
  })

  // -------------------------------------------------------------------------
  // fix 2(b) — ambiguous sanitized name rejected at add time
  // -------------------------------------------------------------------------

  it("a raw operationId whose SANITIZED name collides with another operation's is rejected", async () => {
    // "users_me" (raw) and "users.me" (raw) both sanitize to "users_me" —
    // designating either as verifyOperationId is ambiguous for the runtime
    // sanitized-name match.
    const result = await addOpenApiPlatform({
      id: "petstore-verify-ambiguous",
      displayName: "Petstore (verify ambiguous)",
      specUrl: `${baseUrl}/openapi.json`,
      verifyOperationId: "users_me",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("verify-op-invalid")
    if (result.error.kind !== "verify-op-invalid") return
    expect(result.error.message).toContain("ambiguous")
  })

  // -------------------------------------------------------------------------
  // fix 6 — required params declared at the PATH-ITEM level (inherited by
  // every operation under that path) must count toward the "no required
  // params" verifyOperationId invariant, not just operation-level parameters.
  // -------------------------------------------------------------------------

  it("a GET whose required parameter is declared at the path-item level (not the operation) is rejected", async () => {
    const result = await addOpenApiPlatform({
      id: "petstore-verify-pathitem-param",
      displayName: "Petstore (verify path-item param)",
      specUrl: `${baseUrl}/openapi.json`,
      verifyOperationId: "getOrg",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("verify-op-invalid")
    if (result.error.kind !== "verify-op-invalid") return
    expect(result.error.message).toContain("required parameters")
  })
})
