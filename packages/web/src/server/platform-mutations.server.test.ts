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

    // The web now sends a structured CliConnectionInput (raw commandLine + declared
    // args + a policy with network as a discriminated mode) — the server tokenizes
    // commandLine → argv and maps network → allowNet, then CliConnectionSchema.parse.
    function validConnection() {
      return {
        tools: [
          {
            name: "echo",
            commandLine: "/bin/echo hello",
            args: [],
            policy: {
              cwd: cliScratchDir,
              readPaths: [cliScratchDir],
              writePaths: [],
              network: { mode: "denied" as const },
              timeoutMs: 5000,
              envAllow: {},
            },
          },
        ],
      }
    }

    beforeEach(async () => {
      cliScratchDir = await mkdtemp(join(tmpdir(), "junction-plat-cli-scratch-"))
    })

    afterEach(async () => {
      await rm(cliScratchDir, { recursive: true, force: true })
    })

    it("adds a cli platform from a structured connection input (tokenizes commandLine → argv)", async () => {
      const result = await mutateAddPlatform({
        kind: "cli",
        id: "local-cli",
        displayName: "Local CLI",
        connection: validConnection(),
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.platform.kind).toBe("cli")

      // Read back: the server must have tokenized "/bin/echo hello" into two literal segments.
      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("local-cli")
      expect(stored.isOk()).toBe(true)
      if (stored.isOk()) {
        const argv = stored.value.cli?.tools[0]?.argv
        expect(argv).toEqual([
          { kind: "literal", value: "/bin/echo" },
          { kind: "literal", value: "hello" },
        ])
      }
    })

    it("returns an error when argv[0] is not an absolute path (CliConnectionSchema.parse rejects)", async () => {
      const result = await mutateAddPlatform({
        kind: "cli",
        id: "bad-cli",
        displayName: "Bad",
        connection: {
          tools: [
            {
              name: "echo",
              commandLine: "echo hello", // relative binary — argv[0] must be absolute
              args: [],
              policy: {
                cwd: cliScratchDir,
                readPaths: [cliScratchDir],
                writePaths: [],
                network: { mode: "denied" as const },
                timeoutMs: 5000,
                envAllow: {},
              },
            },
          ],
        },
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error.length).toBeGreaterThan(0)
    })

    it("returns an error for a connection with no tools", async () => {
      const result = await mutateAddPlatform({
        kind: "cli",
        id: "bad-cli-2",
        displayName: "Bad",
        connection: { tools: [] },
      })
      expect(result.ok).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // mutateUpdatePlatform — full per-kind rebuild (inc 26 wave 3)
  // ---------------------------------------------------------------------------

  describe("mutateUpdatePlatform", () => {
    it("edits the whole connection, not just displayName (changes the stored url)", async () => {
      const added = await mutateAddPlatform({
        kind: "mcp-http",
        id: "edit-me",
        displayName: "Old Name",
        url: "https://old.example.com/mcp",
        authHeader: "X-Special",
      })
      expect(added.ok).toBe(true)

      // Full edit: new url + new displayName + a new auth header — a real rebuild.
      const result = await mutateUpdatePlatform({
        kind: "mcp-http",
        id: "edit-me",
        displayName: "New Name",
        url: "https://new.example.com/mcp",
        authHeader: "X-Updated",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.platform.displayName).toBe("New Name")

      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("edit-me")
      expect(stored.isOk()).toBe(true)
      if (stored.isOk() && stored.value.connection?.transport === "http") {
        // The regression guard opposite to the old displayName-only behaviour:
        // the url and auth header actually changed.
        expect(stored.value.connection.url).toBe("https://new.example.com/mcp")
        expect(stored.value.connection.auth?.header).toBe("X-Updated")
      }
    })

    it("adds an env map to a stdio platform on edit and persists it", async () => {
      const added = await mutateAddPlatform({
        kind: "mcp-stdio",
        id: "stdio-env",
        displayName: "Stdio",
        command: "my-mcp",
      })
      expect(added.ok).toBe(true)

      const result = await mutateUpdatePlatform({
        kind: "mcp-stdio",
        id: "stdio-env",
        displayName: "Stdio",
        command: "my-mcp",
        env: { NODE_ENV: "production", GH_HOST: "github.example.com" },
      })
      expect(result.ok).toBe(true)

      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("stdio-env")
      expect(stored.isOk()).toBe(true)
      if (stored.isOk() && stored.value.connection?.transport === "stdio") {
        expect(stored.value.connection.env).toEqual({
          NODE_ENV: "production",
          GH_HOST: "github.example.com",
        })
      }
    })

    it("returns not-found for a nonexistent platform id", async () => {
      const result = await mutateUpdatePlatform({
        kind: "mcp-http",
        id: "nonexistent",
        displayName: "X",
        url: "https://example.com/mcp",
      })
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
