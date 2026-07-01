// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for platform-mutations.server.ts helpers.
// Covers: add (mcp-http, mcp-stdio, cli — no network needed), delete (incl. in-use FK),
// update (displayName-only), and refresh (non-openapi rejection).
// Uses a real temp DB (same pattern as profile-mutations.server.test.ts).
// openapi/graphql add paths need network (spec fetch/introspection) — not exercised
// here; the error-message mapping for their failure kinds is covered by the switch
// itself (pure) and the CLI's own orchestration-package tests cover the fetch paths.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRepositories,
  getDatabase,
  getPaths,
  newCredentialId,
  newPlatformId,
} from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  mutateAddPlatform,
  mutateDeletePlatform,
  mutateRefreshPlatform,
  mutateUpdatePlatform,
} from "./platform-mutations.server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeRepos(home: string) {
  const prevHome = process.env.JUNCTION_HOME
  process.env.JUNCTION_HOME = home
  const dbResult = await getDatabase(getPaths())
  if (dbResult.isErr()) throw new Error(String(dbResult.error))
  if (prevHome === undefined) delete process.env.JUNCTION_HOME
  else process.env.JUNCTION_HOME = prevHome
  return createRepositories(dbResult.value)
}

describe("platform-mutations.server", () => {
  let tmpHome: string
  let prevHome: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "junction-plat-test-"))
    prevHome = process.env.JUNCTION_HOME
    process.env.JUNCTION_HOME = tmpHome
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    await rm(tmpHome, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // mutateAddPlatform — mcp-http
  // ---------------------------------------------------------------------------

  describe("mutateAddPlatform (mcp-http)", () => {
    it("adds an mcp-http platform and persists it", async () => {
      const result = await mutateAddPlatform({
        kind: "mcp-http",
        id: "gh-http",
        displayName: "GitHub HTTP",
        url: "https://example.com/mcp",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.platform.id).toBe("gh-http")
      expect(result.platform.kind).toBe("mcp")
      expect(result.platform.displayName).toBe("GitHub HTTP")

      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("gh-http")
      expect(stored.isOk()).toBe(true)
    })

    it("returns an error when url is missing (missing-field)", async () => {
      const result = await mutateAddPlatform({
        kind: "mcp-http",
        id: "bad-http",
        displayName: "Bad",
        url: "",
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error.length).toBeGreaterThan(0)
    })

    it("respects a custom authHeader", async () => {
      const result = await mutateAddPlatform({
        kind: "mcp-http",
        id: "gh-http-2",
        displayName: "GitHub HTTP 2",
        url: "https://example.com/mcp",
        authHeader: "X-Custom-Auth",
      })
      expect(result.ok).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // mutateAddPlatform — mcp-stdio
  // ---------------------------------------------------------------------------

  describe("mutateAddPlatform (mcp-stdio)", () => {
    it("adds an mcp-stdio platform and persists it", async () => {
      const result = await mutateAddPlatform({
        kind: "mcp-stdio",
        id: "local-stdio",
        displayName: "Local Stdio",
        command: "npx",
        args: ["-y", "@some/mcp-server"],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.platform.kind).toBe("mcp")

      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("local-stdio")
      expect(stored.isOk()).toBe(true)
    })

    it("returns an error when command is missing", async () => {
      const result = await mutateAddPlatform({
        kind: "mcp-stdio",
        id: "bad-stdio",
        displayName: "Bad",
        command: "",
      })
      expect(result.ok).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // mutateAddPlatform — cli
  // ---------------------------------------------------------------------------

  describe("mutateAddPlatform (cli)", () => {
    // A scratch dir OUTSIDE tmpHome — granting readPaths on os.tmpdir() itself
    // would expose tmpHome/credentials.enc.json (validatePolicy's secret-path guard
    // correctly rejects that), so the policy's cwd/readPaths use a sibling dir instead.
    let cliScratchDir: string

    function validDescriptor() {
      return JSON.stringify({
        tools: [
          {
            name: "echo",
            argv: [
              { kind: "literal", value: "/bin/echo" },
              { kind: "literal", value: "hello" },
            ],
            policy: {
              cwd: cliScratchDir,
              readPaths: [cliScratchDir],
              writePaths: [],
              allowNet: [],
              timeoutMs: 5000,
            },
          },
        ],
      })
    }

    beforeEach(async () => {
      cliScratchDir = await mkdtemp(join(tmpdir(), "junction-plat-cli-scratch-"))
    })

    afterEach(async () => {
      await rm(cliScratchDir, { recursive: true, force: true })
    })

    it("adds a cli platform from a valid JSON descriptor", async () => {
      const result = await mutateAddPlatform({
        kind: "cli",
        id: "local-cli",
        displayName: "Local CLI",
        descriptor: validDescriptor(),
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.platform.kind).toBe("cli")

      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("local-cli")
      expect(stored.isOk()).toBe(true)
    })

    it("returns an error for invalid JSON descriptor text", async () => {
      const result = await mutateAddPlatform({
        kind: "cli",
        id: "bad-cli",
        displayName: "Bad",
        descriptor: "{not valid json",
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toMatch(/descriptor/i)
    })

    it("returns an error for a descriptor missing required fields", async () => {
      const result = await mutateAddPlatform({
        kind: "cli",
        id: "bad-cli-2",
        displayName: "Bad",
        descriptor: JSON.stringify({ tools: [] }),
      })
      expect(result.ok).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // mutateUpdatePlatform — displayName-only edit
  // ---------------------------------------------------------------------------

  describe("mutateUpdatePlatform", () => {
    it("updates displayName only, preserving other fields", async () => {
      const added = await mutateAddPlatform({
        kind: "mcp-http",
        id: "rename-me",
        displayName: "Old Name",
        url: "https://example.com/mcp",
        authHeader: "X-Special",
      })
      expect(added.ok).toBe(true)

      const result = await mutateUpdatePlatform({ id: "rename-me", displayName: "New Name" })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.platform.displayName).toBe("New Name")

      // Connection field (authHeader) must survive the rename — get+upsert, not re-add.
      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("rename-me")
      expect(stored.isOk()).toBe(true)
      if (stored.isOk()) {
        expect(stored.value.connection?.transport).toBe("http")
        if (stored.value.connection?.transport === "http") {
          expect(stored.value.connection.auth?.header).toBe("X-Special")
        }
      }
    })

    it("returns not-found for a nonexistent platform id", async () => {
      const result = await mutateUpdatePlatform({ id: "nonexistent", displayName: "X" })
      expect(result.ok).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // mutateDeletePlatform
  // ---------------------------------------------------------------------------

  describe("mutateDeletePlatform", () => {
    it("deletes an existing platform successfully", async () => {
      await mutateAddPlatform({
        kind: "mcp-http",
        id: "to-delete",
        displayName: "To Delete",
        url: "https://example.com/mcp",
      })
      const result = await mutateDeletePlatform("to-delete")
      expect(result.ok).toBe(true)
    })

    it("returns not-found for a nonexistent platform id", async () => {
      const result = await mutateDeletePlatform("nonexistent")
      expect(result.ok).toBe(false)
    })

    it("returns an in-use error when a credential still references the platform", async () => {
      const repos = await makeRepos(tmpHome)
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "In Use" })
      await repos.credentials.create({
        id: newCredentialId(),
        platformId,
        profileName: "acct",
        kind: "bearer",
        secretRef: "keyring://junction/ref_plat_in_use",
      })

      const result = await mutateDeletePlatform(String(platformId))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toMatch(/in use/i)
    })
  })

  // ---------------------------------------------------------------------------
  // mutateRefreshPlatform — non-openapi rejection (no network needed)
  // ---------------------------------------------------------------------------

  describe("mutateRefreshPlatform", () => {
    it("rejects refresh for a non-openapi platform", async () => {
      await mutateAddPlatform({
        kind: "mcp-http",
        id: "not-openapi",
        displayName: "Not OpenAPI",
        url: "https://example.com/mcp",
      })
      const result = await mutateRefreshPlatform("not-openapi")
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toMatch(/openapi/i)
    })

    it("returns not-found for a nonexistent platform id", async () => {
      const result = await mutateRefreshPlatform("nonexistent")
      expect(result.ok).toBe(false)
    })
  })
})
