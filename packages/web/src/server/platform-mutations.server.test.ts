// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for platform-mutations.server.ts helpers.
// Covers: add (mcp-http, mcp-stdio, cli — no network needed), delete (incl. in-use FK),
// update (displayName-only), and refresh (non-openapi rejection).
// Uses a real temp DB (same pattern as profile-mutations.server.test.ts).
// openapi/graphql add paths need network (spec fetch/introspection) — not exercised
// here; the error-message mapping for their failure kinds is covered by the switch
// itself (pure) and the CLI's own orchestration-package tests cover the fetch paths.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRepositories,
  getDatabase,
  getPaths,
  isFullAccess,
  newCredentialId,
  newPlatformId,
} from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  discoverCliBinary,
  listUnlinkedCredentials,
  mutateAddFullAccessCliPlatform,
  mutateAddPlatform,
  mutateBindCredentialToPlatform,
  mutateDeletePlatform,
  mutateRefreshPlatform,
  mutateSetFullAccessCliShortcuts,
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
        const cli = stored.value.cli
        // This path adds a declared CLI platform, so narrow off the full-access branch.
        const argv = cli && !isFullAccess(cli) ? cli.tools[0]?.argv : undefined
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
  // mutateAddPlatform — http (inc 30.7)
  // ---------------------------------------------------------------------------

  describe("mutateAddPlatform (http)", () => {
    function validHttpConnection() {
      return {
        baseUrl: "https://api.example.com",
        tools: [
          {
            name: "listIssues",
            description: "List issues for a repo",
            method: "GET" as const,
            path: "/repos/{owner}/{repo}/issues",
            params: [
              { name: "owner", in: "path" as const, type: "string" as const, required: true },
              { name: "repo", in: "path" as const, type: "string" as const, required: true },
              { name: "state", in: "query" as const, type: "string" as const, required: false },
            ],
          },
        ],
      }
    }

    it("adds an http platform from a valid connection (assemble → HttpConnectionSchema authority)", async () => {
      const result = await mutateAddPlatform({
        kind: "http",
        id: "rest-api",
        displayName: "REST API",
        connection: validHttpConnection(),
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.platform.kind).toBe("http")

      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("rest-api")
      expect(stored.isOk()).toBe(true)
      if (stored.isOk()) {
        expect(stored.value.http?.baseUrl).toBe("https://api.example.com")
        expect(stored.value.http?.tools).toHaveLength(1)
        expect(stored.value.http?.tools[0]?.params).toHaveLength(3)
      }
    })

    it("respects a bearer auth scheme", async () => {
      const result = await mutateAddPlatform({
        kind: "http",
        id: "rest-api-bearer",
        displayName: "REST API Bearer",
        connection: { ...validHttpConnection(), auth: { scheme: "bearer" } },
      })
      expect(result.ok).toBe(true)
      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("rest-api-bearer")
      expect(stored.isOk()).toBe(true)
      if (stored.isOk()) {
        expect(stored.value.http?.auth?.scheme).toBe("bearer")
      }
    })

    it("respects an apiKey auth scheme with a header name", async () => {
      const result = await mutateAddPlatform({
        kind: "http",
        id: "rest-api-apikey",
        displayName: "REST API ApiKey",
        connection: {
          ...validHttpConnection(),
          auth: { scheme: "apiKey", name: "X-API-Key" },
        },
      })
      expect(result.ok).toBe(true)
      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get("rest-api-apikey")
      expect(stored.isOk()).toBe(true)
      if (stored.isOk() && stored.value.http?.auth?.scheme === "apiKey") {
        expect(stored.value.http.auth.name).toBe("X-API-Key")
      }
    })

    it("returns a fieldError when a path placeholder has no matching declared path param", async () => {
      const result = await mutateAddPlatform({
        kind: "http",
        id: "bad-http-mismatch",
        displayName: "Bad",
        connection: {
          baseUrl: "https://api.example.com",
          tools: [
            {
              name: "listIssues",
              description: "List issues",
              method: "GET" as const,
              // {repo} has no matching declared path param — the core schema's
              // path↔param cross-check refine must reject this.
              path: "/repos/{owner}/{repo}/issues",
              params: [
                { name: "owner", in: "path" as const, type: "string" as const, required: true },
              ],
            },
          ],
        },
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error.length).toBeGreaterThan(0)
      expect(result.fieldErrors).toBeDefined()
    })

    it("returns an error for a connection with no tools", async () => {
      const result = await mutateAddPlatform({
        kind: "http",
        id: "bad-http-no-tools",
        displayName: "Bad",
        connection: { baseUrl: "https://api.example.com", tools: [] },
      })
      expect(result.ok).toBe(false)
    })

    it("returns an error for an invalid baseUrl", async () => {
      const result = await mutateAddPlatform({
        kind: "http",
        id: "bad-http-baseurl",
        displayName: "Bad",
        connection: { ...validHttpConnection(), baseUrl: "not-a-url" },
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
        expect(stored.value.connection.auth?.scheme).toBe("bearer")
        if (stored.value.connection.auth?.scheme === "bearer") {
          expect(stored.value.connection.auth.header).toBe("X-Updated")
        }
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
        name: "acct-14",
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

  // ---------------------------------------------------------------------------
  // Full CLI access — discovery + install (inc 41.4)
  // ---------------------------------------------------------------------------

  describe("discoverCliBinary", () => {
    it("rejects an invalid bare-command name", async () => {
      const result = await discoverCliBinary("../etc/passwd")
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toMatch(/not a valid bare command name/)
    })

    it("returns an empty candidate list (not an error) for a name found nowhere", async () => {
      const prevPath = process.env.PATH
      process.env.PATH = tmpHome // a dir with no matching binary
      try {
        const result = await discoverCliBinary("definitely-not-a-real-binary-xyz")
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.candidates).toEqual([])
      } finally {
        process.env.PATH = prevPath
      }
    })

    it("finds a fake executable placed on PATH and reports it as metadata only", async () => {
      const binDir = await mkdtemp(join(tmpdir(), "junction-plat-fa-bin-"))
      const binPath = join(binDir, "faketool")
      await writeFile(binPath, "#!/bin/sh\necho hi\n")
      await chmod(binPath, 0o755)
      const prevPath = process.env.PATH
      process.env.PATH = binDir
      try {
        const result = await discoverCliBinary("faketool")
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.candidates).toHaveLength(1)
          expect(result.candidates[0]?.source).toBe("path")
          // Metadata-only shape: exactly {path, realpath, source, version?} — no
          // extra fields (e.g. no raw fs stat data) leak through.
          expect(Object.keys(result.candidates[0] ?? {}).sort()).toEqual(
            ["path", "realpath", "source"].sort(),
          )
        }
      } finally {
        process.env.PATH = prevPath
        await rm(binDir, { recursive: true, force: true })
      }
    })
  })

  describe("mutateAddFullAccessCliPlatform", () => {
    let binDir: string
    let binPath: string

    beforeEach(async () => {
      binDir = await mkdtemp(join(tmpdir(), "junction-plat-fa-install-"))
      binPath = join(binDir, "faketool")
      await writeFile(binPath, "#!/bin/sh\necho 'usage: faketool [flags]'\n")
      await chmod(binPath, 0o755)
    })

    afterEach(async () => {
      await rm(binDir, { recursive: true, force: true })
    })

    it.skipIf(process.platform !== "darwin")(
      "installs a full-access platform and persists it (metadata-only result)",
      async () => {
        const result = await mutateAddFullAccessCliPlatform({
          id: "fa-install",
          displayName: "FA Install",
          binaryPath: binPath,
        })
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error("expected ok")
        expect(result.platform.kind).toBe("cli")
        expect(result.nodeCount).toBeGreaterThanOrEqual(1)
        // Metadata-only: no binaryPath/schema/policy leaked in the result shape.
        expect(Object.keys(result.platform).sort()).toEqual(["displayName", "id", "kind"].sort())

        const repos = await makeRepos(tmpHome)
        const stored = await repos.platforms.get("fa-install")
        expect(stored.isOk()).toBe(true)
        if (stored.isOk()) {
          const cli = stored.value.cli
          expect(cli && isFullAccess(cli)).toBe(true)
        }
      },
    )

    it("a nonexistent binary path never throws — returns an ok/err Result", async () => {
      const result = await mutateAddFullAccessCliPlatform({
        id: "fa-missing",
        displayName: "FA Missing",
        binaryPath: "/definitely/not/a/real/path/xyz",
      })
      expect(typeof result.ok).toBe("boolean")
    })
  })

  // ---------------------------------------------------------------------------
  // mutateSetFullAccessCliShortcuts — the shortcuts editing surface (inc 41.5)
  // ---------------------------------------------------------------------------

  describe("mutateSetFullAccessCliShortcuts", () => {
    /** Seed a Full CLI access platform directly — shortcuts editing needs no sandbox. Returns the generated id. */
    async function seedFullAccessPlatform(): Promise<string> {
      const repos = await makeRepos(tmpHome)
      const id = newPlatformId()
      const result = await repos.platforms.upsert({
        id,
        kind: "cli",
        displayName: "GitHub CLI",
        cli: {
          mode: "full-access",
          binaryPath: "/usr/bin/gh",
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 5_000,
            envAllow: {},
          },
          schema: {
            binaryName: "gh",
            extractedAt: new Date().toISOString(),
            root: {
              path: [],
              parsed: true,
              explored: true,
              flags: [],
              positionals: [],
              subcommands: [],
            },
            truncated: false,
          },
        },
      })
      if (result.isErr()) throw new Error("failed to seed full-access platform")
      return String(id)
    }

    function shortcutInput(name: string) {
      return {
        name,
        commandLine: "/usr/bin/gh pr list",
        args: [],
        policy: {
          cwd: "/tmp",
          readPaths: ["/tmp"],
          writePaths: [],
          network: { mode: "denied" as const },
          timeoutMs: 5_000,
          envAllow: {},
        },
      }
    }

    it("adds a shortcut to a platform with none yet", async () => {
      const id = await seedFullAccessPlatform()
      const result = await mutateSetFullAccessCliShortcuts({
        id,
        shortcuts: [shortcutInput("pr_list")],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.platform.id).toBe(id)

      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get(id)
      expect(stored.isOk()).toBe(true)
      if (!stored.isOk() || !stored.value.cli || !isFullAccess(stored.value.cli)) return
      expect(stored.value.cli.shortcuts?.map((s) => s.name)).toEqual(["pr_list"])
    })

    it("removing all shortcuts drops the field (round-trips back to none)", async () => {
      const id = await seedFullAccessPlatform()
      await mutateSetFullAccessCliShortcuts({
        id,
        shortcuts: [shortcutInput("pr_list")],
      })
      const result = await mutateSetFullAccessCliShortcuts({ id, shortcuts: [] })
      expect(result.ok).toBe(true)

      const repos = await makeRepos(tmpHome)
      const stored = await repos.platforms.get(id)
      if (!stored.isOk() || !stored.value.cli || !isFullAccess(stored.value.cli)) return
      expect(stored.value.cli.shortcuts ?? []).toEqual([])
    })

    it("refuses on a declared-mode cli platform (not-full-access)", async () => {
      const repos = await makeRepos(tmpHome)
      const declaredId = newPlatformId()
      await repos.platforms.upsert({
        id: declaredId,
        kind: "cli",
        displayName: "Declared Tool",
        cli: {
          mode: "declared" as const,
          tools: [
            {
              name: "echo",
              argv: [
                { kind: "literal", value: "/bin/echo" },
                { kind: "arg", name: "msg" },
              ],
              args: [{ name: "msg", type: "string" as const, required: false }],
              policy: {
                cwd: "/tmp",
                readPaths: ["/tmp"],
                writePaths: [],
                allowNet: [],
                timeoutMs: 5_000,
                envAllow: {},
              },
            },
          ],
        },
      })

      const result = await mutateSetFullAccessCliShortcuts({
        id: String(declaredId),
        shortcuts: [shortcutInput("pr_list")],
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toMatch(/Full CLI access/)
    })

    it("a nonexistent platform id reports a clean not-found error", async () => {
      const result = await mutateSetFullAccessCliShortcuts({
        id: "does-not-exist",
        shortcuts: [],
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toMatch(/not found/i)
    })

    it("an invalid shortcut descriptor (missing cwd) reports fieldErrors, not a throw", async () => {
      const id = await seedFullAccessPlatform()
      const bad = shortcutInput("bad_shortcut")
      bad.policy.cwd = ""
      const result = await mutateSetFullAccessCliShortcuts({
        id,
        shortcuts: [bad],
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.fieldErrors).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Inline credential bind (increment 43, Phase 2, Slice B) — listUnlinkedCredentials
  // + mutateBindCredentialToPlatform. Uses a declared "cli" platform (isVerifiable
  // is always false for cli — see data.server.ts) so the confirmThenBind path
  // exercises with NO network dependency, per the method file's B0 note that
  // verify-none kinds (env/cli/http) must route to confirmThenBind, not
  // verifyThenBind.
  // ---------------------------------------------------------------------------

  describe("listUnlinkedCredentials + mutateBindCredentialToPlatform", () => {
    /** A minimal declared "cli" platform — isVerifiable(p) is false for "cli". */
    async function seedCliPlatform(id = newPlatformId()) {
      const repos = await makeRepos(tmpHome)
      await repos.platforms.upsert({
        id,
        kind: "cli",
        displayName: "Bind Test CLI",
        cli: {
          mode: "declared" as const,
          tools: [
            {
              name: "echo",
              argv: [
                { kind: "literal", value: "/bin/echo" },
                { kind: "arg", name: "msg" },
              ],
              args: [{ name: "msg", type: "string" as const, required: false }],
              policy: {
                cwd: "/tmp",
                readPaths: ["/tmp"],
                writePaths: [],
                allowNet: [],
                timeoutMs: 5_000,
                envAllow: {},
              },
            },
          ],
        },
      })
      // Return the branded PlatformId (not String(id), which strips the brand)
      // so callers can pass it straight to repos.credentials.create, whose
      // platformId is a branded PlatformId. A PlatformId is still assignable to
      // the plain-string server-fn inputs the other callers use.
      return id
    }

    /** An UNLINKED (platformId: null) "env" credential — listUnlinked's target row shape. */
    async function seedUnlinkedCredential(profileName = "default", name = "unlinked-cred") {
      const repos = await makeRepos(tmpHome)
      const id = newCredentialId()
      await repos.credentials.create({
        id,
        name,
        platformId: null,
        profileName,
        kind: "env",
        secretRef: `keyring://junction/ref_${name}`,
      })
      return String(id)
    }

    it("listUnlinkedCredentials returns metadata only — NO secret/secretRef field", async () => {
      await seedUnlinkedCredential("default", "unlinked-a")
      const result = await listUnlinkedCredentials()
      expect(result.length).toBeGreaterThan(0)
      for (const c of result) {
        expect(c).not.toHaveProperty("secret")
        expect(c).not.toHaveProperty("secretRef")
        expect(c.platformId).toBeNull()
      }
    })

    it("listUnlinkedCredentials excludes a platform-linked credential", async () => {
      const platformId = await seedCliPlatform()
      const repos = await makeRepos(tmpHome)
      await repos.credentials.create({
        id: newCredentialId(),
        name: "linked-cred",
        platformId,
        profileName: "default",
        kind: "env",
        secretRef: "keyring://junction/ref_linked",
      })
      const result = await listUnlinkedCredentials()
      expect(result.some((c) => c.name === "linked-cred")).toBe(false)
    })

    it("listUnlinkedCredentials(kind) filters by kind", async () => {
      await seedUnlinkedCredential("default", "env-cred")
      const repos = await makeRepos(tmpHome)
      await repos.credentials.create({
        id: newCredentialId(),
        name: "bearer-cred",
        platformId: null,
        profileName: "default",
        kind: "bearer",
        secretRef: "keyring://junction/ref_bearer",
      })
      const result = await listUnlinkedCredentials("env")
      expect(result.every((c) => c.kind === "env")).toBe(true)
      expect(result.some((c) => c.name === "bearer-cred")).toBe(false)
    })

    it("binds an unlinked credential to a verify-none (cli) platform via confirmThenBind — unverified:false", async () => {
      const platformId = await seedCliPlatform()
      const credentialId = await seedUnlinkedCredential()

      const result = await mutateBindCredentialToPlatform({ credentialId, platformId })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.verified).toBe(false)
      expect(result.credential.platformId).toBe(platformId)

      const repos = await makeRepos(tmpHome)
      const stored = await repos.credentials.get(credentialId)
      expect(stored.isOk()).toBe(true)
      if (stored.isOk()) expect(stored.value.platformId).toBe(platformId)

      // No longer unlinked.
      const unlinked = await listUnlinkedCredentials()
      expect(unlinked.some((c) => c.id === credentialId)).toBe(false)
    })

    it("a not-found credentialId reports a clean error, not a throw", async () => {
      const platformId = await seedCliPlatform()
      const result = await mutateBindCredentialToPlatform({
        credentialId: "does-not-exist",
        platformId,
      })
      expect(result.ok).toBe(false)
    })

    it("a not-found platformId reports a clean error, not a throw", async () => {
      const credentialId = await seedUnlinkedCredential()
      const result = await mutateBindCredentialToPlatform({
        credentialId,
        platformId: "does-not-exist",
      })
      expect(result.ok).toBe(false)
    })

    it("kind-incompatible: binding a non-accepted kind to the platform is refused by core", async () => {
      // A cli platform's kind-compat matrix accepts ["env","file","bearer"]
      // (bearer is always accepted, back-compat) — "api-key" is NOT in that
      // set, so this exercises the SAME isKindAccepted gate addCredential
      // uses, from the bind path.
      const platformId = await seedCliPlatform()
      const repos = await makeRepos(tmpHome)
      const id = newCredentialId()
      await repos.credentials.create({
        id,
        name: "api-key-cred",
        platformId: null,
        profileName: "default",
        kind: "api-key",
        secretRef: "keyring://junction/ref_api_key",
      })
      const result = await mutateBindCredentialToPlatform({
        credentialId: String(id),
        platformId,
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      if (!("error" in result)) throw new Error("expected an error message, not verifyFailed")
      expect(result.error).toMatch(/not accepted/i)
    })

    it("duplicate-account: a second credential with the SAME profileName on the SAME platform is refused (not a silent overwrite)", async () => {
      const platformId = await seedCliPlatform()
      const firstId = await seedUnlinkedCredential("default", "first-cred")
      const firstBind = await mutateBindCredentialToPlatform({
        credentialId: firstId,
        platformId,
      })
      expect(firstBind.ok).toBe(true)

      const secondId = await seedUnlinkedCredential("default", "second-cred")
      const secondBind = await mutateBindCredentialToPlatform({
        credentialId: secondId,
        platformId,
      })
      expect(secondBind.ok).toBe(false)
      if (secondBind.ok) throw new Error("expected error")
      if (!("error" in secondBind)) throw new Error("expected an error message, not verifyFailed")
      expect(secondBind.error).toMatch(/already connected/i)

      // The second credential is STILL unlinked — no partial/silent write.
      const stillUnlinked = await listUnlinkedCredentials()
      expect(stillUnlinked.some((c) => c.id === secondId)).toBe(true)
    })
  })
})
