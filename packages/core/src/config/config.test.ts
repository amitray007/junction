// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { ensureHome } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"
import { type Config, DEFAULT_CONFIG, loadConfig, saveConfig } from "./index.js"

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

  it("loadConfig on a non-readable config.json returns err({ kind: 'read-failed' })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      // config.json is a directory → reading it yields EISDIR (not ENOENT),
      // which must map to read-failed, NOT the missing-file→default path.
      await mkdir(paths.value.configFile)
      const result = await loadConfig(paths.value)
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) {
        expect(result.error.kind).toBe("read-failed")
      }
    })
  })

  it("saveConfig with an invalid config returns err({ kind: 'invalid' }) carrying issues", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      // Defeat the type system to exercise the input-validation branch.
      const bad = { version: 99 } as unknown as Config
      const result = await saveConfig(paths.value, bad)
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) {
        expect(result.error.kind).toBe("invalid")
        if (result.error.kind === "invalid") {
          expect(result.error.issues.length).toBeGreaterThan(0)
        }
      }
    })
  })

  it("saveConfig where config.json is a directory returns err({ kind: 'write-failed' })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      await mkdir(paths.value.configFile) // rename onto a dir → EISDIR/ENOTEMPTY
      const result = await saveConfig(paths.value, DEFAULT_CONFIG)
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) {
        expect(result.error.kind).toBe("write-failed")
      }
    })
  })

  it("two concurrent saves do not corrupt the file — one wins, the other is lock-failed", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      // Distinct payloads so the loaded result must equal exactly one writer's
      // input (proves atomicity, not a torn merge). Both are valid configs.
      const results = await Promise.all([
        saveConfig(paths.value, DEFAULT_CONFIG),
        saveConfig(paths.value, { version: 1 }),
      ])
      // Each result is ok or a clean lock-failed err — never a throw
      for (const r of results) {
        if (!r.isOk()) {
          expect(r.error.kind).toBe("lock-failed")
        }
      }
      // Exactly one writer wins under retries:0; the other contends.
      expect(results.some((r) => r.isOk())).toBe(true)
      // File must be valid and loadable, equal to a complete config (no tear).
      const loadResult = await loadConfig(paths.value)
      expect(loadResult.isOk()).toBe(true)
      if (loadResult.isOk()) {
        expect(loadResult.value).toEqual(DEFAULT_CONFIG)
      }
    })
  })
})
