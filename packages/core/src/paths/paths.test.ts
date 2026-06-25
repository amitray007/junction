// SPDX-License-Identifier: AGPL-3.0-only

import { stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { withTempHome } from "../testing/index.js"
import { ensureHome, getPaths } from "./index.js"

describe("paths", () => {
  it("default home is ~/.junction when JUNCTION_HOME is unset", () => {
    const saved = process.env.JUNCTION_HOME
    delete process.env.JUNCTION_HOME
    try {
      const p = getPaths()
      expect(p.home).toBe(path.join(os.homedir(), ".junction"))
    } finally {
      if (saved !== undefined) process.env.JUNCTION_HOME = saved
    }
  })

  it("JUNCTION_HOME override is honored", async () => {
    await withTempHome(async (home) => {
      const p = getPaths()
      expect(p.home).toBe(home)
    })
  })

  it("configFile is config.json inside home", async () => {
    await withTempHome(async (home) => {
      const p = getPaths()
      expect(p.configFile).toBe(path.join(home, "config.json"))
    })
  })

  it("dbFile is junction.db inside home", async () => {
    await withTempHome(async (home) => {
      const p = getPaths()
      expect(p.dbFile).toBe(path.join(home, "junction.db"))
    })
  })

  it("credentialsFile is credentials.enc.json inside home", async () => {
    await withTempHome(async (home) => {
      const p = getPaths()
      expect(p.credentialsFile).toBe(path.join(home, "credentials.enc.json"))
    })
  })

  it("masterKeyFile is master.key inside home", async () => {
    await withTempHome(async (home) => {
      const p = getPaths()
      expect(p.masterKeyFile).toBe(path.join(home, "master.key"))
    })
  })

  it("cacheDir resolves to a non-empty string", async () => {
    await withTempHome(async () => {
      const p = getPaths()
      expect(typeof p.cacheDir).toBe("string")
      expect(p.cacheDir.length).toBeGreaterThan(0)
    })
  })

  it("ensureHome creates the home dir and returns ok(paths)", async () => {
    await withTempHome(async (home) => {
      const result = await ensureHome()
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.home).toBe(home)
      }
    })
  })

  it("ensureHome sets home dir mode to 0700 on POSIX", async () => {
    if (process.platform === "win32") return
    await withTempHome(async (home) => {
      await ensureHome()
      const s = await stat(home)
      expect(s.mode & 0o777).toBe(0o700)
    })
  })
})
