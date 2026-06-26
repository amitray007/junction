// SPDX-License-Identifier: AGPL-3.0-only
// providers.ts unit tests — buildProvider (dispatch-by-kind + asymmetry normalisation)
// and resolveCredentialSecret (no-credential fast-path + credential resolution).
//
// MCP: @junction/mcp-client is mocked so we never need a real MCP transport.
// OpenAPI: a real spec fixture is written to a temp dir (no HTTP server needed to
//   build the provider; the spec is parsed inline).
// Store: JUNCTION_STORE=file to avoid keyring dependency in tests.

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  addCredential,
  createCredentialStore,
  createRepositories,
  err,
  getDatabase,
  getPaths,
  ok,
  type Platform,
  PlatformIdSchema,
  PlatformSchema,
  ResultAsync,
  type ToolProvider,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildProvider, resolveCredentialSecret } from "./providers.js"

// ---------------------------------------------------------------------------
// Mock @junction/mcp-client so MCP tests never open a real transport
// ---------------------------------------------------------------------------

vi.mock("@junction/mcp-client", () => ({
  createMcpProvider: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid OpenAPI 3.0 spec for fixture use. */
const MINIMAL_SPEC = {
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "http://localhost:9999" }],
  paths: {
    "/greet": {
      get: {
        operationId: "getGreeting",
        summary: "Get a greeting",
        responses: { "200": { description: "OK" } },
      },
    },
  },
}

/** Reset JUNCTION_STORE=file for each test to avoid keyring in CI. */
let prevStore: string | undefined
beforeEach(() => {
  prevStore = process.env.JUNCTION_STORE
  process.env.JUNCTION_STORE = "file"
})
afterEach(() => {
  if (prevStore === undefined) delete process.env.JUNCTION_STORE
  else process.env.JUNCTION_STORE = prevStore
})

// ---------------------------------------------------------------------------
// resolveCredentialSecret
// ---------------------------------------------------------------------------

describe("resolveCredentialSecret", () => {
  it("undefined credentialId → {secret:null, account:'public'} without touching the store", async () => {
    // No DB or store needed — the fast-path returns immediately.
    // Pass fake repos/paths objects: if the function touched them it would throw.
    const fakeRepos = {} as Parameters<typeof resolveCredentialSecret>[0]
    const fakePaths = {} as Parameters<typeof resolveCredentialSecret>[1]

    const result = await resolveCredentialSecret(fakeRepos, fakePaths, undefined)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.secret).toBeNull()
      expect(result.value.account).toBe("public")
    }
  })

  it("empty string credentialId → {secret:null, account:'public'} without touching the store", async () => {
    const fakeRepos = {} as Parameters<typeof resolveCredentialSecret>[0]
    const fakePaths = {} as Parameters<typeof resolveCredentialSecret>[1]

    const result = await resolveCredentialSecret(fakeRepos, fakePaths, "")
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.secret).toBeNull()
      expect(result.value.account).toBe("public")
    }
  })

  it("credential not found → {kind:'db', error: not-found}", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const result = await resolveCredentialSecret(repos, paths, "nonexistent-cred-id")
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("db")
        expect(result.error.error.kind).toBe("not-found")
      }
    })
  })

  it("valid credential → {secret: stored value, account: profileName}", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      // Insert a platform so the credential FK resolves.
      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("test-platform"),
        kind: "mcp" as const,
        displayName: "Test Platform",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
      })
      await repos.platforms.upsert(platform)

      // Insert the credential via addCredential (only safe path for secret injection).
      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return
      const store = storeResult.value

      const addResult = await addCredential(
        {
          platformId: "test-platform",
          account: "work",
          kind: "bearer",
          secret: "test-secret-value",
        },
        store,
        repos.credentials,
      )
      expect(addResult.isOk()).toBe(true)
      if (addResult.isErr()) return
      const credential = addResult.value

      // resolveCredentialSecret should find the credential and return the secret.
      const result = await resolveCredentialSecret(repos, paths, credential.id)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.secret).toBe("test-secret-value")
        expect(result.value.account).toBe("work")
      }
    })
  })
})

// ---------------------------------------------------------------------------
// buildProvider — error paths (no networking needed)
// ---------------------------------------------------------------------------

describe("buildProvider — unsupported kind", () => {
  it("returns unsupported-source-kind for an unrecognised platform.kind", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const platform = {
        id: PlatformIdSchema.parse("gql-platform"),
        kind: "graphql" as Platform["kind"],
        displayName: "GraphQL Source",
      } as Platform

      const result = await buildProvider(platform, null, paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("unsupported-source-kind")
        expect((result.error as { platformKind: string }).platformKind).toBe("graphql")
      }
    })
  })
})

describe("buildProvider — MCP", () => {
  it("no connection descriptor → connect-failed", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const platform: Platform = {
        id: PlatformIdSchema.parse("mcp-no-conn"),
        kind: "mcp",
        displayName: "MCP No Conn",
        // connection intentionally absent
      }

      const result = await buildProvider(platform, null, paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("connect-failed")
      }
    })
  })

  it("valid connection → Ok(ToolProvider) [mocked createMcpProvider]", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const platform: Platform = {
        id: PlatformIdSchema.parse("mcp-ok"),
        kind: "mcp",
        displayName: "MCP OK",
        connection: { transport: "http" as const, url: "http://localhost:9999/mcp" },
      }

      // Configure the mock to return a stub ToolProvider.
      const { createMcpProvider } = await import("@junction/mcp-client")
      const stubProvider: ToolProvider = {
        listTools: () => new ResultAsync(Promise.resolve(ok([]))),
        callTool: () => new ResultAsync(Promise.resolve(ok({ content: [] }))),
        close: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(createMcpProvider).mockReturnValue(
        new ResultAsync(Promise.resolve(ok(stubProvider))),
      )

      const result = await buildProvider(platform, null, paths)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        // The returned value is the ToolProvider from the mock.
        expect(result.value).toBe(stubProvider)
      }
      // createMcpProvider was called with the right arguments.
      expect(vi.mocked(createMcpProvider)).toHaveBeenCalledWith(platform.connection, null)
    })
  })

  it("createMcpProvider failure → Err propagated", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const platform: Platform = {
        id: PlatformIdSchema.parse("mcp-fail"),
        kind: "mcp",
        displayName: "MCP Fail",
        connection: { transport: "http" as const, url: "http://localhost:9999/mcp" },
      }

      const { createMcpProvider } = await import("@junction/mcp-client")
      vi.mocked(createMcpProvider).mockReturnValue(
        new ResultAsync(
          Promise.resolve(err({ kind: "connect-failed" as const, cause: "refused" })),
        ),
      )

      const result = await buildProvider(platform, null, paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("connect-failed")
      }
    })
  })
})

describe("buildProvider — OpenAPI", () => {
  it("no openapi descriptor → connect-failed", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const platform: Platform = {
        id: PlatformIdSchema.parse("openapi-no-desc"),
        kind: "openapi",
        displayName: "OpenAPI No Desc",
        // openapi intentionally absent
      }

      const result = await buildProvider(platform, null, paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("connect-failed")
      }
    })
  })

  it("missing cache file → connect-failed", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const platform: Platform = {
        id: PlatformIdSchema.parse("openapi-no-cache"),
        kind: "openapi",
        displayName: "OpenAPI No Cache",
        openapi: { spec: { from: "url" as const, url: "https://example.com/api/openapi.json" } },
      }
      // The openapi/ dir does not exist — no cache file written.

      const result = await buildProvider(platform, null, paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("connect-failed")
      }
    })
  })

  it("invalid JSON in cache file → connect-failed", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const platformId = "openapi-bad-json"
      const cacheDir = join(paths.home, "openapi")
      await mkdir(cacheDir, { recursive: true })
      await writeFile(join(cacheDir, `${platformId}.json`), "not valid json", "utf8")

      const platform: Platform = {
        id: PlatformIdSchema.parse(platformId),
        kind: "openapi",
        displayName: "OpenAPI Bad JSON",
        openapi: { spec: { from: "url" as const, url: "https://example.com/api/openapi.json" } },
      }

      const result = await buildProvider(platform, null, paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("connect-failed")
      }
    })
  })

  it("valid cached spec → Ok(ToolProvider) normalised to ResultAsync", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const platformId = "openapi-ok"
      const cacheDir = join(paths.home, "openapi")
      await mkdir(cacheDir, { recursive: true })
      await writeFile(join(cacheDir, `${platformId}.json`), JSON.stringify(MINIMAL_SPEC), "utf8")

      const platform: Platform = {
        id: PlatformIdSchema.parse(platformId),
        kind: "openapi",
        displayName: "OpenAPI OK",
        openapi: { spec: { from: "url" as const, url: "https://example.com/api/openapi.json" } },
      }

      const result = await buildProvider(platform, null, paths)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        // The returned provider exposes the ToolProvider interface.
        expect(typeof result.value.listTools).toBe("function")
        expect(typeof result.value.callTool).toBe("function")
        expect(typeof result.value.close).toBe("function")

        // listTools should parse the cached spec and return the getGreeting tool.
        const toolsResult = await result.value.listTools()
        expect(toolsResult.isOk()).toBe(true)
        if (toolsResult.isOk()) {
          const names = toolsResult.value.map((t) => t.name)
          expect(names).toContain("getGreeting")
        }

        await result.value.close()
      }
    })
  })
})
