// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for settings.server.ts (mutateSetMcpHost) and config helpers.
// Covers: configErrorMessage switch paths (via observable results), and FIX 4
// (empty mcpHost falls through to env var, not stored as "").

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getMcpHost, getPaths, saveConfig } from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mutateSetMcpHost } from "./settings.server.js"

describe("settings.server", () => {
  let tmpHome: string
  let prevHome: string | undefined
  let prevMcpHost: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "junction-settings-test-"))
    prevHome = process.env.JUNCTION_HOME
    prevMcpHost = process.env.JUNCTION_MCP_HOST
    process.env.JUNCTION_HOME = tmpHome
    delete process.env.JUNCTION_MCP_HOST
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    if (prevMcpHost === undefined) delete process.env.JUNCTION_MCP_HOST
    else process.env.JUNCTION_MCP_HOST = prevMcpHost
    await rm(tmpHome, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // mutateSetMcpHost — valid/invalid/clear
  // ---------------------------------------------------------------------------

  describe("mutateSetMcpHost", () => {
    it("accepts a valid hostname and persists it", async () => {
      const result = await mutateSetMcpHost("localhost:3000")
      expect(result.ok).toBe(true)
    })

    it("accepts a valid bracketed IPv6 host (FIX 3)", async () => {
      const result = await mutateSetMcpHost("[::1]:8080")
      expect(result.ok).toBe(true)
    })

    it("rejects an invalid host (contains scheme)", async () => {
      const result = await mutateSetMcpHost("https://localhost")
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toMatch(/invalid host/i)
    })

    it("clears the host when passed undefined", async () => {
      await mutateSetMcpHost("localhost:4000")
      const result = await mutateSetMcpHost(undefined)
      expect(result.ok).toBe(true)
    })

    it("clears the host when passed empty string", async () => {
      await mutateSetMcpHost("localhost:4000")
      const result = await mutateSetMcpHost("")
      expect(result.ok).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // FIX 4 — empty mcpHost in config falls through to env var
  // ---------------------------------------------------------------------------

  describe("getMcpHost empty-host env fallback (FIX 4)", () => {
    it("hand-written mcpHost='' in config falls back to JUNCTION_MCP_HOST env var", async () => {
      // Write a config with an empty mcpHost string (simulates a hand-edited config).
      const paths = getPaths()
      const saveResult = await saveConfig(paths, { version: 1, mcpHost: "" })
      if (saveResult.isErr()) throw new Error("failed to save config")

      process.env.JUNCTION_MCP_HOST = "env-host:9000"
      const result = await getMcpHost(paths)
      expect(result.isOk()).toBe(true)
      if (result.isErr()) throw new Error("expected ok")
      // Must resolve the env var, not the empty string.
      expect(result.value).toBe("env-host:9000")
    })

    it("hand-written mcpHost=' ' (whitespace) falls back to env var", async () => {
      const paths = getPaths()
      const saveResult = await saveConfig(paths, { version: 1, mcpHost: "   " })
      if (saveResult.isErr()) throw new Error("failed to save config")

      process.env.JUNCTION_MCP_HOST = "env-host:9001"
      const result = await getMcpHost(paths)
      expect(result.isOk()).toBe(true)
      if (result.isErr()) throw new Error("expected ok")
      expect(result.value).toBe("env-host:9001")
    })

    it("valid stored mcpHost takes precedence over env var", async () => {
      const paths = getPaths()
      const setResult = await mutateSetMcpHost("stored-host:5000")
      if (!setResult.ok) throw new Error("set failed")

      process.env.JUNCTION_MCP_HOST = "env-host:9002"
      const result = await getMcpHost(paths)
      expect(result.isOk()).toBe(true)
      if (result.isErr()) throw new Error("expected ok")
      expect(result.value).toBe("stored-host:5000")
    })
  })

  // ---------------------------------------------------------------------------
  // configErrorMessage coverage — exercised via mutateSetMcpHost error paths
  // ---------------------------------------------------------------------------

  describe("configErrorMessage mapping (via observable mutation results)", () => {
    it("invalid host returns a non-empty human-readable error", async () => {
      const result = await mutateSetMcpHost("not a valid host!")
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error.length).toBeGreaterThan(0)
      expect(result.error).not.toBe("undefined")
    })
  })
})
