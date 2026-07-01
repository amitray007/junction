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
    expect(result.value.toolCount).toBe(2)
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
    expect(result.value.toolCount).toBe(1)
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
    expect(result.error.count).toBe(2)
    expect(result.error.cap).toBe(1)
    expect(result.error.tagCounts).toEqual(
      expect.arrayContaining([
        { tag: "pets", count: 1 },
        { tag: "store", count: 1 },
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
