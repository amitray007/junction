// SPDX-License-Identifier: AGPL-3.0-only
// sweepStaleCredDirs tests — increment 32.7 item 2: the cred-* orphan reaper.
//
// Passes a JunctionPaths built directly over an mkdtemp'd dir (not via
// withTempHome / JUNCTION_HOME) — the function takes JunctionPaths explicitly,
// which sidesteps JUNCTION_HOME env-timing entirely.

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { JunctionPaths } from "./index.js"
import { sweepStaleCredDirs } from "./sweep-cred-dirs.js"

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

function makePaths(home: string): JunctionPaths {
  return {
    home,
    configFile: path.join(home, "config.json"),
    cacheDir: path.join(home, "cache"),
    dbFile: path.join(home, "junction.db"),
    credentialsFile: path.join(home, "credentials.enc.json"),
    masterKeyFile: path.join(home, "master.key"),
    auditLogFile: path.join(home, "audit.log"),
    runtimeDir: path.join(home, "run"),
  }
}

let tempHome: string

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), "junction-sweep-test-"))
})

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true })
})

describe("sweepStaleCredDirs — increment 32.7 item 2", () => {
  it("removes only backdated cred-* DIRECTORIES older than the threshold; skips fresh dirs, non-cred dirs, and a backdated FILE named cred-*", async () => {
    const paths = makePaths(tempHome)
    await mkdir(paths.runtimeDir, { recursive: true })

    const oldDir = path.join(paths.runtimeDir, "cred-old")
    const newDir = path.join(paths.runtimeDir, "cred-new")
    const otherDir = path.join(paths.runtimeDir, "other-dir")
    const credFile = path.join(paths.runtimeDir, "cred-file")

    await mkdir(oldDir)
    await mkdir(newDir)
    await mkdir(otherDir)
    await writeFile(credFile, "not a dir")

    // Backdate the old dir and the stray file to 2h ago (beyond the 1h default).
    const backdated = new Date(Date.now() - TWO_HOURS_MS)
    await utimes(oldDir, backdated, backdated)
    await utimes(credFile, backdated, backdated)

    const count = await sweepStaleCredDirs(paths)

    expect(count).toBe(1)

    // cred-old is gone.
    await expect(stat(oldDir)).rejects.toThrow()

    // cred-new, other-dir, and the stray cred-file FILE all remain.
    await expect(stat(newDir)).resolves.toBeDefined()
    await expect(stat(otherDir)).resolves.toBeDefined()
    await expect(stat(credFile)).resolves.toBeDefined()
  })

  it("a missing run/ dir returns 0 and does not throw", async () => {
    const paths = makePaths(tempHome) // runtimeDir never created

    await expect(sweepStaleCredDirs(paths)).resolves.toBe(0)
  })

  it("respects a custom olderThanMs override", async () => {
    const paths = makePaths(tempHome)
    await mkdir(paths.runtimeDir, { recursive: true })

    const dir = path.join(paths.runtimeDir, "cred-recentish")
    await mkdir(dir)
    const backdated = new Date(Date.now() - 5_000) // 5s ago
    await utimes(dir, backdated, backdated)

    // With a 1ms threshold, even a 5s-old dir counts as stale.
    const count = await sweepStaleCredDirs(paths, { olderThanMs: 1 })
    expect(count).toBe(1)
  })
})
