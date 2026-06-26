// SPDX-License-Identifier: AGPL-3.0-only
// Tests: migration 0003 applies on 0000-0002 and openapi descriptor round-trips.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRepositories, getDatabase } from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let tmpHome: string

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "junction-openapi-test-"))
  process.env.JUNCTION_HOME = tmpHome
})

afterEach(async () => {
  delete process.env.JUNCTION_HOME
  await rm(tmpHome, { recursive: true, force: true })
})

describe("migration 0003 + openapi descriptor round-trip", () => {
  it("applies migration 0003 (openapi column exists) on a fresh DB", async () => {
    const { getPaths } = await import("@junction/core")
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    expect(dbResult.isOk()).toBe(true)
    if (!dbResult.isOk()) return

    const db = dbResult.value
    const repos = createRepositories(db)

    // Create a platform with an openapi descriptor
    const platform = {
      id: "test-openapi" as Parameters<typeof repos.platforms.create>[0]["id"],
      kind: "openapi" as const,
      displayName: "Test OpenAPI",
      openapi: {
        spec: { from: "url" as const, url: "http://example.com/openapi.json" },
        auth: { scheme: "apiKey" as const, in: "header" as const, name: "X-API-Key" },
        baseUrl: "http://example.com",
        maxTools: 50,
      },
    }

    const createResult = await repos.platforms.create(platform)
    expect(createResult.isOk()).toBe(true)

    // Read it back and verify the openapi descriptor round-trips correctly
    const getResult = await repos.platforms.get(platform.id)
    expect(getResult.isOk()).toBe(true)
    if (!getResult.isOk()) return

    const loaded = getResult.value
    expect(loaded.kind).toBe("openapi")
    expect(loaded.openapi).toBeDefined()
    expect(loaded.openapi?.spec).toEqual({
      from: "url",
      url: "http://example.com/openapi.json",
    })
    expect(loaded.openapi?.auth).toEqual({
      scheme: "apiKey",
      in: "header",
      name: "X-API-Key",
    })
    expect(loaded.openapi?.baseUrl).toBe("http://example.com")
    expect(loaded.openapi?.maxTools).toBe(50)
  })

  it("platforms without openapi descriptor still load correctly (backward compat)", async () => {
    const { getPaths } = await import("@junction/core")
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (!dbResult.isOk()) return

    const db = dbResult.value
    const repos = createRepositories(db)

    // MCP platform — no openapi field
    const mcp = {
      id: "test-mcp" as Parameters<typeof repos.platforms.create>[0]["id"],
      kind: "mcp" as const,
      displayName: "Test MCP",
      connection: {
        transport: "http" as const,
        url: "http://example.com/mcp",
      },
    }

    await repos.platforms.create(mcp)
    const loaded = await repos.platforms.get(mcp.id)
    expect(loaded.isOk()).toBe(true)
    if (!loaded.isOk()) return
    expect(loaded.value.openapi).toBeUndefined()
    expect(loaded.value.connection?.transport).toBe("http")
  })
})
