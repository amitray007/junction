// SPDX-License-Identifier: AGPL-3.0-only

import { writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { ensureHome } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./index.js"

describe("config", () => {
  it("missing config.json returns ok(DEFAULT_CONFIG)", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const result = await loadConfig(paths.value)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual(DEFAULT_CONFIG)
      }
    })
  })

  it("first write (no pre-existing config.json) succeeds — locks home dir not config.json", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const result = await saveConfig(paths.value, DEFAULT_CONFIG)
      expect(result.isOk()).toBe(true)
    })
  })

  it("save then load returns equal config (round-trip ok)", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const saveResult = await saveConfig(paths.value, DEFAULT_CONFIG)
      expect(saveResult.isOk()).toBe(true)
      const loadResult = await loadConfig(paths.value)
      expect(loadResult.isOk()).toBe(true)
      if (loadResult.isOk()) {
        expect(loadResult.value).toEqual(DEFAULT_CONFIG)
      }
    })
  })

  it("invalid JSON config returns err({ kind: 'invalid' })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      await writeFile(paths.value.configFile, "not valid json", "utf-8")
      const result = await loadConfig(paths.value)
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) {
        expect(result.error.kind).toBe("invalid")
      }
    })
  })

  it("wrong-shape JSON returns err({ kind: 'invalid' })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      await writeFile(paths.value.configFile, JSON.stringify({ version: 99 }), "utf-8")
      const result = await loadConfig(paths.value)
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) {
        expect(result.error.kind).toBe("invalid")
      }
    })
  })

  it("two concurrent saves do not corrupt the file — no throws escape", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const results = await Promise.all([
        saveConfig(paths.value, DEFAULT_CONFIG),
        saveConfig(paths.value, DEFAULT_CONFIG),
      ])
      // Each result is ok or a clean lock-failed err — never a throw
      for (const r of results) {
        if (!r.isOk()) {
          expect(r.error.kind).toBe("lock-failed")
        }
      }
      // At least one write must have succeeded
      expect(results.some((r) => r.isOk())).toBe(true)
      // File must be valid and loadable after concurrent writes
      const loadResult = await loadConfig(paths.value)
      expect(loadResult.isOk()).toBe(true)
    })
  })
})
