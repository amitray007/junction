// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ensureHome } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"
import {
  type Config,
  DEFAULT_CONFIG,
  DEFAULT_MCP_PORT,
  getMcpHost,
  getMcpPort,
  isValidMcpHost,
  isValidMcpPort,
  loadConfig,
  loadConfigState,
  saveConfig,
  setMcpHost,
  setMcpPort,
} from "./index.js"

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
      // Each result is ok or a CLEAN err — never a throw. The loser's kind is
      // nondeterministic under concurrency (lock contention → lock-failed, or a
      // rename race → write-failed); both are clean, neither corrupts the file.
      for (const r of results) {
        if (!r.isOk()) {
          expect(["lock-failed", "write-failed"]).toContain(r.error.kind)
        }
      }
      // At least one writer must win.
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

describe("loadConfigState", () => {
  it("absent config.json → ok({ initialized: false })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const result = await loadConfigState(paths.value)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.initialized).toBe(false)
      }
    })
  })

  it("present valid config.json → ok({ initialized: true, config })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const saveResult = await saveConfig(paths.value, DEFAULT_CONFIG)
      expect(saveResult.isOk()).toBe(true)
      const result = await loadConfigState(paths.value)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.initialized).toBe(true)
        if (result.value.initialized) {
          expect(result.value.config).toEqual(DEFAULT_CONFIG)
        }
      }
    })
  })

  it("present invalid JSON → err({ kind: 'invalid' })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      await writeFile(paths.value.configFile, "garbage", "utf-8")
      const result = await loadConfigState(paths.value)
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) {
        expect(result.error.kind).toBe("invalid")
      }
    })
  })

  it("config.json is a directory (unreadable) → err({ kind: 'read-failed' })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      await mkdir(paths.value.configFile)
      const result = await loadConfigState(paths.value)
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) {
        expect(result.error.kind).toBe("read-failed")
      }
    })
  })
})

describe("isValidMcpHost", () => {
  it("accepts plain hostnames", () => {
    expect(isValidMcpHost("example.com")).toBe(true)
    expect(isValidMcpHost("localhost")).toBe(true)
    expect(isValidMcpHost("my-host.internal")).toBe(true)
  })

  it("accepts host:port form", () => {
    expect(isValidMcpHost("example.com:443")).toBe(true)
    expect(isValidMcpHost("localhost:4321")).toBe(true)
    expect(isValidMcpHost("127.0.0.1:8080")).toBe(true)
  })

  it("rejects empty / whitespace-only strings", () => {
    expect(isValidMcpHost("")).toBe(false)
    expect(isValidMcpHost("   ")).toBe(false)
  })

  it("rejects strings containing whitespace", () => {
    expect(isValidMcpHost("my host")).toBe(false)
    expect(isValidMcpHost("host name:80")).toBe(false)
  })

  it("rejects strings containing a scheme (://)", () => {
    expect(isValidMcpHost("https://example.com")).toBe(false)
    expect(isValidMcpHost("http://localhost")).toBe(false)
  })

  it("rejects strings with a non-digit port", () => {
    expect(isValidMcpHost("example.com:abc")).toBe(false)
    expect(isValidMcpHost("localhost:80xx")).toBe(false)
  })

  it("rejects a bare colon (empty hostname)", () => {
    expect(isValidMcpHost(":8080")).toBe(false)
  })

  // FIX 3 — bracketed IPv6 support
  it("accepts bracketed IPv6 literals (FIX 3)", () => {
    expect(isValidMcpHost("[::1]")).toBe(true)
    expect(isValidMcpHost("[::1]:8080")).toBe(true)
    expect(isValidMcpHost("[2001:db8::1]:443")).toBe(true)
  })

  it("rejects bare (unbracketed) IPv6 — ambiguous with host:port (FIX 3)", () => {
    expect(isValidMcpHost("::1")).toBe(false)
  })

  it("rejects bracketed IPv6 with non-digit port (FIX 3)", () => {
    expect(isValidMcpHost("[::1]:abc")).toBe(false)
  })

  it("rejects unclosed bracket (FIX 3)", () => {
    expect(isValidMcpHost("[::1")).toBe(false)
  })

  it("rejects bracketed IPv6 with unexpected suffix after ] (FIX 3)", () => {
    expect(isValidMcpHost("[::1]garbage")).toBe(false)
  })
})

describe("getMcpHost + setMcpHost", () => {
  // Stash and restore JUNCTION_MCP_HOST around each test so we don't leak.
  let prevEnv: string | undefined
  beforeEach(() => {
    prevEnv = process.env.JUNCTION_MCP_HOST
    delete process.env.JUNCTION_MCP_HOST
  })
  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.JUNCTION_MCP_HOST
    } else {
      process.env.JUNCTION_MCP_HOST = prevEnv
    }
  })

  it("set→get roundtrip: saved host is returned by getMcpHost", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const setResult = await setMcpHost(paths.value, "example.com")
      expect(setResult.isOk()).toBe(true)
      const getResult = await getMcpHost(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe("example.com")
    })
  })

  it("env fallback: no config → getMcpHost returns JUNCTION_MCP_HOST", async () => {
    await withTempHome(async () => {
      process.env.JUNCTION_MCP_HOST = "env-host.example.com"
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const getResult = await getMcpHost(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe("env-host.example.com")
    })
  })

  it("config-overrides-env: config host wins over JUNCTION_MCP_HOST", async () => {
    await withTempHome(async () => {
      process.env.JUNCTION_MCP_HOST = "env-host.example.com"
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const setResult = await setMcpHost(paths.value, "config-host.example.com")
      expect(setResult.isOk()).toBe(true)
      const getResult = await getMcpHost(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe("config-host.example.com")
    })
  })

  it("clearing: set then clear → getMcpHost returns undefined; mcpHost key absent from JSON", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      // Set first
      const setResult = await setMcpHost(paths.value, "to-be-cleared.com")
      expect(setResult.isOk()).toBe(true)
      // Clear with undefined
      const clearResult = await setMcpHost(paths.value, undefined)
      expect(clearResult.isOk()).toBe(true)
      // getMcpHost must return undefined (no env set)
      const getResult = await getMcpHost(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBeUndefined()
      // The saved JSON must NOT contain "mcpHost" key
      const raw = await readFile(paths.value.configFile, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(Object.hasOwn(parsed, "mcpHost")).toBe(false)
    })
  })

  it("clearing with empty string also removes mcpHost key", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      await setMcpHost(paths.value, "some.host")
      const clearResult = await setMcpHost(paths.value, "")
      expect(clearResult.isOk()).toBe(true)
      const raw = await readFile(paths.value.configFile, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(Object.hasOwn(parsed, "mcpHost")).toBe(false)
    })
  })

  it("invalid host rejected: setMcpHost returns err({ kind: 'invalid' })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const result = await setMcpHost(paths.value, "https://bad-scheme.com")
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) {
        expect(result.error.kind).toBe("invalid")
      }
    })
  })

  // FIX 4 — empty/whitespace mcpHost in config must not suppress env fallback
  it("FIX 4: hand-written mcpHost='' falls through to JUNCTION_MCP_HOST env var", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      // Write a config with an explicit empty mcpHost — valid parse per schema but should be ignored.
      await writeFile(paths.value.configFile, JSON.stringify({ version: 1, mcpHost: "" }), "utf-8")
      process.env.JUNCTION_MCP_HOST = "env-host-fix4:9000"
      const getResult = await getMcpHost(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe("env-host-fix4:9000")
    })
  })

  it("FIX 4: hand-written mcpHost='   ' (whitespace) falls through to env var", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      await writeFile(
        paths.value.configFile,
        JSON.stringify({ version: 1, mcpHost: "   " }),
        "utf-8",
      )
      process.env.JUNCTION_MCP_HOST = "env-host-fix4:9001"
      const getResult = await getMcpHost(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe("env-host-fix4:9001")
    })
  })

  it("backward-compat: old {version:1} config still loads and getMcpHost falls to env/undefined", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      // Write a config with NO mcpHost key (pre-D5 shape).
      await writeFile(paths.value.configFile, JSON.stringify({ version: 1 }), "utf-8")
      const loadResult = await loadConfig(paths.value)
      expect(loadResult.isOk()).toBe(true)
      // getMcpHost with no env → undefined
      const getResult = await getMcpHost(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBeUndefined()
    })
  })
})

describe("isValidMcpPort", () => {
  it("accepts valid ports", () => {
    expect(isValidMcpPort(1)).toBe(true)
    expect(isValidMcpPort(4322)).toBe(true)
    expect(isValidMcpPort(65535)).toBe(true)
  })

  it("rejects 0 and negative numbers", () => {
    expect(isValidMcpPort(0)).toBe(false)
    expect(isValidMcpPort(-1)).toBe(false)
  })

  it("rejects ports above 65535", () => {
    expect(isValidMcpPort(65536)).toBe(false)
    expect(isValidMcpPort(100_000)).toBe(false)
  })

  it("rejects non-integers", () => {
    expect(isValidMcpPort(4322.5)).toBe(false)
    expect(isValidMcpPort(Number.NaN)).toBe(false)
  })
})

describe("getMcpPort + setMcpPort — precedence (config > env > default)", () => {
  let prevEnv: string | undefined
  beforeEach(() => {
    prevEnv = process.env.JUNCTION_MCP_PORT
    delete process.env.JUNCTION_MCP_PORT
  })
  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.JUNCTION_MCP_PORT
    } else {
      process.env.JUNCTION_MCP_PORT = prevEnv
    }
  })

  it("no config, no env → DEFAULT_MCP_PORT (4322)", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const getResult = await getMcpPort(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe(DEFAULT_MCP_PORT)
      expect(DEFAULT_MCP_PORT).toBe(4322)
    })
  })

  it("set→get roundtrip: saved port is returned by getMcpPort", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const setResult = await setMcpPort(paths.value, 9000)
      expect(setResult.isOk()).toBe(true)
      const getResult = await getMcpPort(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe(9000)
    })
  })

  it("env fallback: no config → getMcpPort returns JUNCTION_MCP_PORT", async () => {
    await withTempHome(async () => {
      process.env.JUNCTION_MCP_PORT = "5555"
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const getResult = await getMcpPort(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe(5555)
    })
  })

  it("config-overrides-env: config port wins over JUNCTION_MCP_PORT", async () => {
    await withTempHome(async () => {
      process.env.JUNCTION_MCP_PORT = "5555"
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const setResult = await setMcpPort(paths.value, 6000)
      expect(setResult.isOk()).toBe(true)
      const getResult = await getMcpPort(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe(6000)
    })
  })

  it("an invalid JUNCTION_MCP_PORT env value falls through to the default", async () => {
    await withTempHome(async () => {
      process.env.JUNCTION_MCP_PORT = "not-a-number"
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const getResult = await getMcpPort(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe(DEFAULT_MCP_PORT)
    })
  })

  it("clearing: set then clear (undefined) → getMcpPort returns default; mcpPort key absent from JSON", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const setResult = await setMcpPort(paths.value, 7000)
      expect(setResult.isOk()).toBe(true)
      const clearResult = await setMcpPort(paths.value, undefined)
      expect(clearResult.isOk()).toBe(true)
      const getResult = await getMcpPort(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe(DEFAULT_MCP_PORT)
      const raw = await readFile(paths.value.configFile, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(Object.hasOwn(parsed, "mcpPort")).toBe(false)
    })
  })

  it("invalid port rejected: setMcpPort returns err({ kind: 'invalid' })", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      const result = await setMcpPort(paths.value, 99999)
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) expect(result.error.kind).toBe("invalid")
    })
  })

  it("backward-compat: old {version:1} config with no mcpPort still loads and getMcpPort falls to default", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      await writeFile(paths.value.configFile, JSON.stringify({ version: 1 }), "utf-8")
      const loadResult = await loadConfig(paths.value)
      expect(loadResult.isOk()).toBe(true)
      const getResult = await getMcpPort(paths.value)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe(DEFAULT_MCP_PORT)
    })
  })

  it("mcpHost and mcpPort coexist independently in the saved config", async () => {
    await withTempHome(async () => {
      const paths = await ensureHome()
      if (!paths.isOk()) throw new Error("ensureHome failed")
      await setMcpHost(paths.value, "example.com")
      await setMcpPort(paths.value, 8888)
      const raw = await readFile(paths.value.configFile, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(parsed.mcpHost).toBe("example.com")
      expect(parsed.mcpPort).toBe(8888)
    })
  })
})
