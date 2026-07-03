// SPDX-License-Identifier: AGPL-3.0-only
// makeResolveProvider tests — increment 28.95 GAP-2.
//
// Drives the skip/warn branches of the shared source-ref → provider resolver
// (used by both `junction mcp serve` stdio and `junction serve` HTTP). Uses a
// real temp-home DB (getDatabase + createRepositories, same pattern as
// providers.test.ts) and a real file-backed CredentialStore so the branches
// under test are exercised against the actual persistence/store contracts,
// not hand-rolled fakes that could silently drift from them.
//
// @junction/mcp-client is mocked (as in providers.test.ts) so the mcp-kind
// resolution never opens a real transport — only the resolution LOGIC above
// buildProvider is under test here, not mcp-client's connect behaviour.

import {
  addCredential,
  type CredentialStore,
  createCredentialStore,
  createRepositories,
  err,
  getDatabase,
  getPaths,
  ok,
  PlatformIdSchema,
  PlatformSchema,
  ResultAsync,
  type SourceRef,
  type ToolProvider,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeResolveProvider } from "./resolve-provider.js"

vi.mock("@junction/mcp-client", () => ({
  createMcpProvider: vi.fn(),
}))

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

function sourceRef(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    platformId: PlatformIdSchema.parse("test-platform"),
    toolNamespace: "testns",
    enabled: true,
    ...overrides,
  }
}

describe("makeResolveProvider — authDeclared-but-no-credential warn", () => {
  it("mcp http platform with auth declared + no credentialId: proceeds (secret null) but logs the warn", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("test-platform"),
        kind: "mcp" as const,
        displayName: "MCP With Auth",
        connection: {
          transport: "http" as const,
          url: "https://example.com/mcp",
          auth: { scheme: "bearer" as const, header: "Authorization" },
        },
      })
      await repos.platforms.upsert(platform)

      const { createMcpProvider } = await import("@junction/mcp-client")
      const stubProvider: ToolProvider = {
        listTools: () => new ResultAsync(Promise.resolve(ok([]))),
        callTool: () => new ResultAsync(Promise.resolve(ok({ content: [] }))),
        close: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(createMcpProvider).mockReturnValue(
        new ResultAsync(Promise.resolve(ok(stubProvider))),
      )

      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return

      const logs: string[] = []
      const resolveProvider = makeResolveProvider(repos, storeResult.value, paths, {
        logPrefix: "test",
        log: (msg) => logs.push(msg),
      })

      const result = await resolveProvider(sourceRef({ credentialId: undefined }))
      expect(result.isOk()).toBe(true)

      expect(logs.some((l) => l.includes("declares auth but no credential is attached"))).toBe(true)
    })
  })

  it("openapi platform with auth declared + no credentialId: logs the warn (mirrors the mcp case for the other authDeclared branch)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("test-platform"),
        kind: "openapi" as const,
        displayName: "OpenAPI With Auth",
        openapi: {
          spec: { from: "url" as const, url: "https://example.com/openapi.json" },
          auth: { scheme: "bearer" as const },
        },
      })
      await repos.platforms.upsert(platform)

      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return

      const logs: string[] = []
      const resolveProvider = makeResolveProvider(repos, storeResult.value, paths, {
        logPrefix: "test",
        log: (msg) => logs.push(msg),
      })

      // No cached openapi spec exists — buildProvider will fail (connect-failed)
      // AFTER the warn is logged. We only assert the warn fired; the downstream
      // connect failure is exercised elsewhere (providers.test.ts).
      const result = await resolveProvider(sourceRef({ credentialId: undefined }))
      expect(result.isErr()).toBe(true)

      expect(logs.some((l) => l.includes("declares auth but no credential is attached"))).toBe(true)
    })
  })
})

describe("makeResolveProvider — credential-not-found skip", () => {
  it("sourceRef.credentialId points at a missing credential → Err connect-failed + logs 'not found — skipping'", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("test-platform"),
        kind: "mcp" as const,
        displayName: "MCP Test",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
      })
      await repos.platforms.upsert(platform)

      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return

      const logs: string[] = []
      const resolveProvider = makeResolveProvider(repos, storeResult.value, paths, {
        logPrefix: "test",
        log: (msg) => logs.push(msg),
      })

      const result = await resolveProvider(sourceRef({ credentialId: "nonexistent-cred-id" }))
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("connect-failed")
      }
      expect(logs.some((l) => l.includes("not found — skipping"))).toBe(true)
    })
  })
})

describe("makeResolveProvider — store-read-failed skip", () => {
  it("store.get returns Err → Err connect-failed + logs 'credential store read failed — skipping'", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("test-platform"),
        kind: "mcp" as const,
        displayName: "MCP Test",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
      })
      await repos.platforms.upsert(platform)

      const realStoreResult = await createCredentialStore(paths)
      expect(realStoreResult.isOk()).toBe(true)
      if (realStoreResult.isErr()) return
      const realStore = realStoreResult.value

      const addResult = await addCredential(
        { platformId: "test-platform", account: "work", kind: "bearer", secret: "s3cr3t" },
        platform,
        realStore,
        repos.credentials,
      )
      expect(addResult.isOk()).toBe(true)
      if (addResult.isErr()) return
      const credential = addResult.value

      // Fake store whose get() always fails — isolates the store-read-failed
      // branch without needing to corrupt real on-disk state.
      const failingStore: CredentialStore = {
        backend: realStore.backend,
        get: () =>
          new ResultAsync(
            Promise.resolve(err({ kind: "io-failed" as const, cause: "injected failure" })),
          ),
        set: realStore.set.bind(realStore),
        delete: realStore.delete.bind(realStore),
      }

      const logs: string[] = []
      const resolveProvider = makeResolveProvider(repos, failingStore, paths, {
        logPrefix: "test",
        log: (msg) => logs.push(msg),
      })

      const result = await resolveProvider(sourceRef({ credentialId: credential.id }))
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("connect-failed")
      }
      expect(logs.some((l) => l.includes("credential store read failed — skipping"))).toBe(true)
    })
  })
})

describe("makeResolveProvider — lost secret (store.get → Ok(null))", () => {
  it("credential row present but store.get returns Ok(null) → resolution proceeds with no injected credential (never throws, never fakes auth)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("test-platform"),
        kind: "mcp" as const,
        displayName: "MCP Test",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
      })
      await repos.platforms.upsert(platform)

      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return
      const store = storeResult.value

      const addResult = await addCredential(
        { platformId: "test-platform", account: "work", kind: "bearer", secret: "will-be-lost" },
        platform,
        store,
        repos.credentials,
      )
      expect(addResult.isOk()).toBe(true)
      if (addResult.isErr()) return
      const credential = addResult.value

      // Lose the secret without removing the credential row: store.get(secretRef)
      // now returns Ok(null) while repos.credentials.get(credential.id) still succeeds.
      const deleteResult = await store.delete(credential.secretRef)
      expect(deleteResult.isOk()).toBe(true)

      // Mock createMcpProvider to observe exactly what secret buildProvider receives.
      const { createMcpProvider } = await import("@junction/mcp-client")
      const stubProvider: ToolProvider = {
        listTools: () => new ResultAsync(Promise.resolve(ok([]))),
        callTool: () => new ResultAsync(Promise.resolve(ok({ content: [] }))),
        close: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(createMcpProvider).mockReturnValue(
        new ResultAsync(Promise.resolve(ok(stubProvider))),
      )

      const resolveProvider = makeResolveProvider(repos, store, paths, { logPrefix: "test" })
      const result = await resolveProvider(sourceRef({ credentialId: credential.id }))

      // Must not throw, and must resolve — the lost secret is treated as no-auth,
      // never a crash and never a fake credential value.
      expect(result.isOk()).toBe(true)
      // buildProvider (via createMcpProvider) was called with `null` as the
      // resolved secret — proves the lost value never got silently substituted.
      expect(vi.mocked(createMcpProvider)).toHaveBeenCalledWith(platform.connection, null)
    })
  })
})
