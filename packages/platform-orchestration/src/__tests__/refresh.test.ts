// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import type { Platform } from "@junction/core"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { addOpenApiPlatform } from "../openapi.js"
import { refreshOpenApiPlatform } from "../refresh.js"

const SPEC_V1 = {
  openapi: "3.0.3",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "http://localhost:9999" }],
  paths: {
    "/pets": { get: { operationId: "listPets", responses: { "200": { description: "ok" } } } },
  },
}

const SPEC_V2 = {
  ...SPEC_V1,
  paths: {
    ...SPEC_V1.paths,
    "/store": { get: { operationId: "listStore", responses: { "200": { description: "ok" } } } },
  },
}

let currentSpec: object = SPEC_V1
let baseUrl: string
let server: ReturnType<typeof createServer>
let junctionHome: string
const savedJunctionHome = process.env.JUNCTION_HOME

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(currentSpec))
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://localhost:${port}`

  junctionHome = await mkdtemp(path.join(os.tmpdir(), "jx-po-refresh-test-"))
  process.env.JUNCTION_HOME = junctionHome
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(junctionHome, { recursive: true, force: true })
  if (savedJunctionHome === undefined) delete process.env.JUNCTION_HOME
  else process.env.JUNCTION_HOME = savedJunctionHome
})

afterEach(() => {
  currentSpec = SPEC_V1
  process.env.JUNCTION_HOME = junctionHome
})

describe("refreshOpenApiPlatform", () => {
  it("re-fetches the spec and reports the old/new tool count delta", async () => {
    const added = await addOpenApiPlatform({
      id: "petstore-refresh",
      displayName: "Petstore",
      specUrl: `${baseUrl}/openapi.json`,
    })
    expect(added.isOk()).toBe(true)
    if (!added.isOk()) return

    currentSpec = SPEC_V2
    const result = await refreshOpenApiPlatform({ platform: added.value.platform })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.oldCount).toBe(1)
    expect(result.value.newCount).toBe(2)
  })

  it("refuses when the refreshed spec exceeds maxTools (never clobbers)", async () => {
    const added = await addOpenApiPlatform({
      id: "petstore-refresh-cap",
      displayName: "Petstore",
      specUrl: `${baseUrl}/openapi.json`,
      maxTools: 1,
    })
    expect(added.isOk()).toBe(true)
    if (!added.isOk()) return

    currentSpec = SPEC_V2
    const result = await refreshOpenApiPlatform({ platform: added.value.platform })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("too-many-tools")
  })

  it("refresh on a non-openapi platform returns not-openapi", async () => {
    const mcpPlatform: Platform = {
      id: "mcp-plat",
      kind: "mcp",
      displayName: "MCP Plat",
      connection: { transport: "http", url: "https://example.com" },
    }
    const result = await refreshOpenApiPlatform({ platform: mcpPlatform })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error).toEqual({ kind: "not-openapi", platformKind: "mcp" })
  })

  it("refresh on a non-url spec returns not-url-spec", async () => {
    const inlinePlatform: Platform = {
      id: "inline-plat",
      kind: "openapi",
      displayName: "Inline Plat",
      openapi: { spec: { from: "inline", document: SPEC_V1 }, maxTools: 75 },
    }
    const result = await refreshOpenApiPlatform({ platform: inlinePlatform })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error).toEqual({ kind: "not-url-spec", specFrom: "inline" })
  })
})
