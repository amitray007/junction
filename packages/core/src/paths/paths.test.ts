// SPDX-License-Identifier: AGPL-3.0-only

import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { withTempHome } from "../testing/index.js"
import { ensureHome, getPaths } from "./index.js"

describe("paths", () => {
  it("default home is ~/.junction when JUNCTION_HOME is unset", () => {
    const saved = process.env["JUNCTION_HOME"]
    delete process.env["JUNCTION_HOME"]
    try {
      const p = getPaths()
      expect(p.home).toBe(path.join(os.homedir(), ".junction"))
    } finally {
      if (saved !== undefined) process.env["JUNCTION_HOME"] = saved
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
})
