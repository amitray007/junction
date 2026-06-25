// SPDX-License-Identifier: AGPL-3.0-only
// CLI edge tests for `junction profile list`.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRepositories, getDatabase, getPaths, newProfileId } from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

describe("profile list command (unit)", () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    home = await mkdtemp(join(tmpdir(), "junction-cli-test-"))
    process.env.JUNCTION_HOME = home
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it("empty DB returns empty profile list", async () => {
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return

    const repos = createRepositories(dbResult.value)
    const listResult = await repos.profiles.list()
    expect(listResult.isOk()).toBe(true)
    if (listResult.isOk()) {
      expect(listResult.value).toEqual([])
    }
  })

  it("returns profiles after insert", async () => {
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return

    const repos = createRepositories(dbResult.value)
    await repos.profiles.create({
      id: newProfileId(),
      name: "work",
      mcpEndpointPath: "/profiles/work/mcp",
      sources: [],
    })

    const listResult = await repos.profiles.list()
    expect(listResult.isOk()).toBe(true)
    if (listResult.isOk()) {
      expect(listResult.value.length).toBe(1)
      expect(listResult.value[0]?.name).toBe("work")
    }
  })
})
