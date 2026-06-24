// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, err, getLogger, getPaths, ok, VERSION } from "./index.js"

it("core exposes a version", () => {
  expect(VERSION).toBe("0.0.0")
})

describe("barrel exports", () => {
  it("ok and err are exported and functional", () => {
    const r = ok(42)
    expect(r.isOk()).toBe(true)
    const e = err({ kind: "read-failed" as const, cause: new Error("x") })
    expect(e.isOk()).toBe(false)
  })

  it("DEFAULT_CONFIG is version 1", () => {
    expect(DEFAULT_CONFIG.version).toBe(1)
  })

  it("getLogger returns a logger with all methods", () => {
    const logger = getLogger()
    expect(typeof logger.debug).toBe("function")
    expect(typeof logger.info).toBe("function")
    expect(typeof logger.warn).toBe("function")
    expect(typeof logger.error).toBe("function")
  })

  it("getPaths returns home, configFile, cacheDir", () => {
    const saved = process.env.JUNCTION_HOME
    process.env.JUNCTION_HOME = "/tmp/junction-barrel-test"
    try {
      const p = getPaths()
      expect(p.home).toBe("/tmp/junction-barrel-test")
      expect(p.configFile).toContain("config.json")
      expect(typeof p.cacheDir).toBe("string")
    } finally {
      if (saved === undefined) delete process.env.JUNCTION_HOME
      else process.env.JUNCTION_HOME = saved
    }
  })
})
