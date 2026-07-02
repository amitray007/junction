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

  // ---------------------------------------------------------------------------
  // profile show — metadata + sources, no secretRef
  // ---------------------------------------------------------------------------
  it("profile show --name returns profile metadata and source list", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      // Setup: platform + credential + profile + source
      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "show-plat",
          "--display-name",
          "Show Plat",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )
      const addResult = await new Promise<{ stdout: string }>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "add",
            "--platform",
            "show-plat",
            "--account",
            "work",
            "--kind",
            "bearer",
            "--token-stdin",
            "--json",
          ],
          { env },
          (_err, stdout) => resolve({ stdout }),
        )
        child.stdin?.write("show-test-secret")
        child.stdin?.end()
      })
      const credId = (JSON.parse(addResult.stdout.trim()) as { credential: { id: string } })
        .credential.id

      await execFileAsync(
        "node",
        [distIndex, "profile", "create", "--name", "showprof", "--json"],
        {
          env,
        },
      )
      await execFileAsync(
        "node",
        [
          distIndex,
          "profile",
          "add-source",
          "--profile",
          "showprof",
          "--platform",
          "show-plat",
          "--credential",
          credId,
          "--namespace",
          "showns",
          "--json",
        ],
        { env },
      )

      const { stdout } = await execFileAsync(
        "node",
        [distIndex, "profile", "show", "--name", "showprof", "--json"],
        { env },
      )
      const parsed = JSON.parse(stdout.trim()) as {
        ok: boolean
        profile?: { name: string }
        sources?: Array<{ namespace: string; enabled: boolean }>
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.profile?.name).toBe("showprof")
      expect(parsed.sources).toHaveLength(1)
      expect(parsed.sources?.[0]?.namespace).toBe("showns")
      expect(parsed.sources?.[0]?.enabled).toBe(true)
      // CRITICAL: secretRef must NOT appear in show output
      expect(stdout).not.toContain("show-test-secret")
      expect(stdout).not.toContain("secretRef")
    })
  })

  // ---------------------------------------------------------------------------
  // profile disable-source / enable-source / remove-source lifecycle
  // ---------------------------------------------------------------------------
  it("profile disable-source, enable-source, remove-source lifecycle", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "tog-plat",
          "--display-name",
          "Toggle Plat",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )
      const addResult = await new Promise<{ stdout: string }>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "add",
            "--platform",
            "tog-plat",
            "--account",
            "work",
            "--kind",
            "bearer",
            "--token-stdin",
            "--json",
          ],
          { env },
          (_err, stdout) => resolve({ stdout }),
        )
        child.stdin?.write("tog-test-secret")
        child.stdin?.end()
      })
      const credId = (JSON.parse(addResult.stdout.trim()) as { credential: { id: string } })
        .credential.id

      await execFileAsync("node", [distIndex, "profile", "create", "--name", "togprof", "--json"], {
        env,
      })
      await execFileAsync(
        "node",
        [
          distIndex,
          "profile",
          "add-source",
          "--profile",
          "togprof",
          "--platform",
          "tog-plat",
          "--credential",
          credId,
          "--namespace",
          "togns",
          "--json",
        ],
        { env },
      )

      // disable-source
      const disableOut = await execFileAsync(
        "node",
        [
          distIndex,
          "profile",
          "disable-source",
          "--profile",
          "togprof",
          "--namespace",
          "togns",
          "--json",
        ],
        { env },
      )
      const disableParsed = JSON.parse(disableOut.stdout.trim()) as {
        ok: boolean
        enabled?: boolean
      }
      expect(disableParsed.ok).toBe(true)
      expect(disableParsed.enabled).toBe(false)

      // verify show reflects disabled state
      const showDisabled = await execFileAsync(
        "node",
        [distIndex, "profile", "show", "--name", "togprof", "--json"],
        { env },
      )
      const showDisabledParsed = JSON.parse(showDisabled.stdout.trim()) as {
        sources?: Array<{ enabled: boolean }>
      }
      expect(showDisabledParsed.sources?.[0]?.enabled).toBe(false)

      // enable-source
      const enableOut = await execFileAsync(
        "node",
        [
          distIndex,
          "profile",
          "enable-source",
          "--profile",
          "togprof",
          "--namespace",
          "togns",
          "--json",
        ],
        { env },
      )
      const enableParsed = JSON.parse(enableOut.stdout.trim()) as {
        ok: boolean
        enabled?: boolean
      }
      expect(enableParsed.ok).toBe(true)
      expect(enableParsed.enabled).toBe(true)

      // remove-source
      const removeOut = await execFileAsync(
        "node",
        [
          distIndex,
          "profile",
          "remove-source",
          "--profile",
          "togprof",
          "--namespace",
          "togns",
          "--json",
        ],
        { env },
      )
      const removeParsed = JSON.parse(removeOut.stdout.trim()) as { ok: boolean }
      expect(removeParsed.ok).toBe(true)

      // source gone from show
      const showAfter = await execFileAsync(
        "node",
        [distIndex, "profile", "show", "--name", "togprof", "--json"],
        { env },
      )
      const showAfterParsed = JSON.parse(showAfter.stdout.trim()) as {
        sources?: unknown[]
      }
      expect(showAfterParsed.sources).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // profile delete
  // ---------------------------------------------------------------------------
  it("profile delete --name removes the profile and exits 0", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }

      await execFileAsync("node", [distIndex, "profile", "create", "--name", "delprof", "--json"], {
        env,
      })

      const { stdout } = await execFileAsync(
        "node",
        [distIndex, "profile", "delete", "--name", "delprof", "--json"],
        { env },
      )
      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; name?: string }
      expect(parsed.ok).toBe(true)
      expect(parsed.name).toBe("delprof")

      // verify it's gone from list
      const listAfter = await execFileAsync("node", [distIndex, "profile", "list", "--json"], {
        env,
      })
      const remaining = JSON.parse(listAfter.stdout.trim()) as unknown[]
      expect(remaining).toHaveLength(0)
    })
  })
})
