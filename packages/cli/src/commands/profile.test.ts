// SPDX-License-Identifier: AGPL-3.0-only
// CLI edge tests for `junction profile list`.
//
// The "unit" suite resolves @junction/core to SOURCE (vitest alias), so it runs
// under `pnpm verify` without a build. The "built bin" suite drives the compiled
// dist/index.js end-to-end (DB created + migrated from the packaged migrations);
// it is skipped when dist/ is absent so a source-only `verify` stays green.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createRepositories, getDatabase, getPaths, newProfileId } from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js")
// Resolve core's built dist relative to this package's node_modules symlink so we
// can confirm the migrations were packaged. The built bin can only migrate a DB
// when @junction/core's dist/migrations/ exists (the build step copies it). A
// bare/stale dist (bin present, migrations absent — the CI state) must NOT run
// these tests; require BOTH the bin and the packaged migrations.
const coreDistMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@junction/core/dist/migrations",
)
const builtBinReady = existsSync(distIndex) && existsSync(coreDistMigrations)

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

describe.skipIf(!builtBinReady)("profile list command (built bin, child process)", () => {
  it("on a fresh home prints the empty-state message to stdout and exits 0", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const { stdout } = await execFileAsync("node", [distIndex, "profile", "list"], { env })
      expect(stdout).toContain("No profiles yet")
    })
  })

  it("--json on a fresh home prints an empty JSON array and exits 0", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const { stdout } = await execFileAsync("node", [distIndex, "profile", "list", "--json"], {
        env,
      })
      const parsed: unknown = JSON.parse(stdout.trim())
      expect(parsed).toEqual([])
    })
  })

  it("creates + migrates the DB at <home>/junction.db on first use", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      await execFileAsync("node", [distIndex, "profile", "list", "--json"], { env })
      expect(existsSync(join(home, "junction.db"))).toBe(true)
    })
  })
})
