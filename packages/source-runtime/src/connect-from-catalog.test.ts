// SPDX-License-Identifier: AGPL-3.0-only
// connect-from-catalog tests — verifyThenAdd / confirmThenAdd against a REAL
// (temp-home) DB + repos, with an in-memory CredentialStore stub (mirrors
// oauth-connect.test.ts's persistOAuthTokens pattern) and verifyCredential
// MOCKED (this package's own module) so the executor's behavior is exercised
// without a real network round-trip. Proves the method file's hard rule
// (§0 fact 3 / §3a): verify ok -> both writes; auth-failed/unreachable ->
// ZERO DB writes; different-kind existing platform -> conflict, no write;
// confirmThenAdd (not-verifiable path) -> writes without ever calling verify.

import {
  type CredentialStore,
  ok as coreOk,
  createRepositories,
  getDatabase,
  getPaths,
  type PlatformInput,
  ResultAsync,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { confirmThenAdd, verifyThenAdd } from "./connect-from-catalog.js"
import { verifyCredential } from "./verify-credential.js"

vi.mock("./verify-credential.js", () => ({
  verifyCredential: vi.fn(),
}))

afterEach(() => {
  vi.mocked(verifyCredential).mockReset()
})

function stubStore(): CredentialStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    backend: "encrypted-file" as const,
    get: (ref: string) =>
      new ResultAsync(Promise.resolve(coreOk(map.has(ref) ? (map.get(ref) as string) : null))),
    set: (ref: string, value: string) => {
      map.set(ref, value)
      return new ResultAsync(Promise.resolve(coreOk(undefined)))
    },
    delete: (ref: string) => {
      map.delete(ref)
      return new ResultAsync(Promise.resolve(coreOk(undefined)))
    },
  }
}

const mcpInput: PlatformInput = {
  kind: "mcp",
  transport: "http",
  url: "https://example.com/mcp",
  authHeader: undefined,
  command: undefined,
  args: undefined,
  tokenEnvVar: undefined,
  env: undefined,
}

describe("verifyThenAdd", () => {
  it("verify ok -> both the platform upsert and the credential write happen", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      vi.mocked(verifyCredential).mockReturnValue(
        new ResultAsync(Promise.resolve(coreOk({ status: "ok" as const }))),
      )

      const result = await verifyThenAdd({
        platformInput: mcpInput,
        displayName: "Test MCP",
        platformId: "github",
        credentialKind: "bearer",
        account: "default",
        secret: "sentinel-pat-do-not-leak",
        paths,
        repos,
        store,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toMatchObject({ verified: true })
      }

      const platformRow = await repos.platforms.get("github")
      expect(platformRow.isOk()).toBe(true)

      const credentials = await repos.credentials.forPlatform("github" as never)
      expect(credentials.isOk()).toBe(true)
      if (credentials.isOk()) {
        expect(credentials.value).toHaveLength(1)
        expect(credentials.value[0]?.kind).toBe("bearer")
      }

      // The plaintext secret never appears in the DB-visible credential row —
      // only behind the store ref.
      if (credentials.isOk()) {
        expect(JSON.stringify(credentials.value)).not.toContain("sentinel-pat-do-not-leak")
      }
    })
  })

  it("verify auth-failed -> ZERO DB writes (no platforms.upsert, no addCredential)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      vi.mocked(verifyCredential).mockReturnValue(
        new ResultAsync(Promise.resolve(coreOk({ status: "auth-failed" as const }))),
      )

      const result = await verifyThenAdd({
        platformInput: mcpInput,
        displayName: "Test MCP",
        platformId: "github",
        credentialKind: "bearer",
        account: "default",
        secret: "wrong-token",
        paths,
        repos,
        store,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual({ verified: false, outcome: { status: "auth-failed" } })
      }

      // No platform row was written.
      const platformRow = await repos.platforms.get("github")
      expect(platformRow.isErr()).toBe(true)
      if (platformRow.isErr()) expect(platformRow.error.kind).toBe("not-found")

      // No credential row was written, and the store received no secret.
      const credentials = await repos.credentials.list()
      expect(credentials.isOk()).toBe(true)
      if (credentials.isOk()) expect(credentials.value).toHaveLength(0)
      expect(store.map.size).toBe(0)
    })
  })

  it("verify unreachable -> ZERO DB writes", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      vi.mocked(verifyCredential).mockReturnValue(
        new ResultAsync(
          Promise.resolve(coreOk({ status: "unreachable" as const, detail: "ECONNREFUSED" })),
        ),
      )

      const result = await verifyThenAdd({
        platformInput: mcpInput,
        displayName: "Test MCP",
        platformId: "github",
        credentialKind: "bearer",
        account: "default",
        secret: "some-token",
        paths,
        repos,
        store,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual({
          verified: false,
          outcome: { status: "unreachable", detail: "ECONNREFUSED" },
        })
      }

      const platformRow = await repos.platforms.get("github")
      expect(platformRow.isErr()).toBe(true)
      const credentials = await repos.credentials.list()
      if (credentials.isOk()) expect(credentials.value).toHaveLength(0)
    })
  })

  it("different-kind existing platform id -> conflict error, no write, verifyCredential never called", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      // Pre-seed an existing "openapi" platform at the same id the mcp input resolves to.
      await repos.platforms.upsert({
        id: "github",
        kind: "openapi",
        displayName: "Existing REST",
        openapi: { spec: { from: "url", url: "https://example.com/openapi.json" } },
      })

      const result = await verifyThenAdd({
        platformInput: mcpInput,
        displayName: "Test MCP",
        platformId: "github",
        credentialKind: "bearer",
        account: "default",
        secret: "some-token",
        paths,
        repos,
        store,
      })

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toEqual({
          kind: "platform-kind-conflict",
          existingKind: "openapi",
          requestedKind: "mcp",
        })
      }
      expect(verifyCredential).not.toHaveBeenCalled()

      // The existing platform row is untouched (still "openapi", not overwritten).
      const platformRow = await repos.platforms.get("github")
      expect(platformRow.isOk()).toBe(true)
      if (platformRow.isOk()) expect(platformRow.value.kind).toBe("openapi")

      const credentials = await repos.credentials.list()
      if (credentials.isOk()) expect(credentials.value).toHaveLength(0)
    })
  })

  it("same-kind existing platform -> credential added to the EXISTING platform, connection untouched", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      await repos.platforms.upsert({
        id: "github",
        kind: "mcp",
        displayName: "Pre-existing display name",
        connection: { transport: "http", url: "https://pre-existing.example.com/mcp" },
      })

      vi.mocked(verifyCredential).mockReturnValue(
        new ResultAsync(Promise.resolve(coreOk({ status: "ok" as const }))),
      )

      const result = await verifyThenAdd({
        platformInput: mcpInput,
        displayName: "Test MCP",
        platformId: "github",
        credentialKind: "bearer",
        account: "default",
        secret: "some-token",
        paths,
        repos,
        store,
      })

      expect(result.isOk()).toBe(true)

      // The pre-existing connection/displayName were NOT overwritten by the fresh guess.
      const platformRow = await repos.platforms.get("github")
      expect(platformRow.isOk()).toBe(true)
      if (platformRow.isOk()) {
        expect(platformRow.value.displayName).toBe("Pre-existing display name")
        expect(platformRow.value.connection?.url).toBe("https://pre-existing.example.com/mcp")
      }

      const credentials = await repos.credentials.forPlatform("github" as never)
      if (credentials.isOk()) expect(credentials.value).toHaveLength(1)
    })
  })
})

describe("confirmThenAdd", () => {
  it("writes platform + credential WITHOUT ever calling verifyCredential (not-verifiable / confirm-gated path)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const httpInput: PlatformInput = {
        kind: "http",
        descriptor: {
          baseUrl: "https://api.github.com",
          auth: { scheme: "bearer" },
          tools: [
            {
              name: "get_authenticated_user",
              description: "x",
              method: "GET",
              path: "/user",
              params: [],
            },
          ],
        },
      }

      const result = await confirmThenAdd({
        platformInput: httpInput,
        displayName: "Custom REST request",
        platformId: "github-http",
        credentialKind: "bearer",
        account: "default",
        secret: "some-pat",
        repos,
        store,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) expect(result.value).toEqual({ unverified: true })
      expect(verifyCredential).not.toHaveBeenCalled()

      const platformRow = await repos.platforms.get("github-http")
      expect(platformRow.isOk()).toBe(true)
      if (platformRow.isOk()) expect(platformRow.value.http?.tools).toHaveLength(1)

      const credentials = await repos.credentials.forPlatform("github-http" as never)
      if (credentials.isOk()) expect(credentials.value).toHaveLength(1)
    })
  })

  it("different-kind collision -> refuses, no write", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      await repos.platforms.upsert({
        id: "github-http",
        kind: "cli",
        displayName: "Existing CLI",
        cli: {
          tools: [
            {
              name: "run",
              argv: [{ kind: "literal", value: "/bin/true" }],
              policy: { cwd: "/tmp", readPaths: [], writePaths: [], allowNet: [], timeoutMs: 1000 },
            },
          ],
        },
      })

      const httpInput: PlatformInput = {
        kind: "http",
        descriptor: {
          baseUrl: "https://api.github.com",
          auth: { scheme: "bearer" },
          tools: [
            {
              name: "get_authenticated_user",
              description: "x",
              method: "GET",
              path: "/user",
              params: [],
            },
          ],
        },
      }

      const result = await confirmThenAdd({
        platformInput: httpInput,
        displayName: "Custom REST request",
        platformId: "github-http",
        credentialKind: "bearer",
        account: "default",
        secret: "some-pat",
        repos,
        store,
      })

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toEqual({
          kind: "platform-kind-conflict",
          existingKind: "cli",
          requestedKind: "http",
        })
      }
      const platformRow = await repos.platforms.get("github-http")
      if (platformRow.isOk()) expect(platformRow.value.kind).toBe("cli")
    })
  })
})
