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

// vi.hoisted so the mock fn exists BEFORE the hoisted vi.mock factory runs —
// vi.mock is lifted to the top of the module, above a plain `const`, so a bare
// closure over it risks a temporal-dead-zone ReferenceError (CodeRabbit review).
const { refreshAccessToken } = vi.hoisted(() => ({ refreshAccessToken: vi.fn() }))

vi.mock("arctic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("arctic")>()
  return {
    ...actual,
    OAuth2Client: vi.fn().mockImplementation(function MockOAuth2Client(this: {
      refreshAccessToken: typeof refreshAccessToken
    }) {
      this.refreshAccessToken = refreshAccessToken
    }),
  }
})

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

describe("makeResolveProvider — oauth2 wiring (inc29-B): the real arctic-backed refreshFn is called", () => {
  it("an expired oauth2 credential with valid refs auto-refreshes via oauthRefreshFn before injection", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("oauth-platform"),
        kind: "mcp" as const,
        displayName: "OAuth MCP",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
      })
      await repos.platforms.upsert(platform)

      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return
      const store = storeResult.value

      await store.set("access-ref", "old-access-token")
      await store.set("refresh-ref", "old-refresh-token")
      await store.set("client-id-ref", "byo-client-id")
      await store.set("client-secret-ref", "byo-client-secret")

      const expiredAt = new Date(Date.now() - 1000).toISOString()
      const createResult = await repos.credentials.create({
        id: "oauth-cred-1",
        name: "work-oauth-cred-1",
        platformId: "oauth-platform",
        profileName: "work",
        kind: "oauth2",
        secretRef: "access-ref",
        oauthMeta: {
          refreshTokenRef: "refresh-ref",
          clientIdRef: "client-id-ref",
          clientSecretRef: "client-secret-ref",
          providerId: "github-app",
          authMode: "authorization_code",
          expiresAt: expiredAt,
          needsReauth: false,
        },
      })
      expect(createResult.isOk()).toBe(true)
      if (createResult.isErr()) return
      const credential = createResult.value

      refreshAccessToken.mockResolvedValueOnce({
        data: { access_token: "rotated-access-token", expires_in: 3600 },
        accessToken: () => "rotated-access-token",
        hasRefreshToken: () => false,
        accessTokenExpiresInSeconds: () => 3600,
        hasScopes: () => false,
      })

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
      const result = await resolveProvider(
        sourceRef({
          platformId: PlatformIdSchema.parse("oauth-platform"),
          credentialId: credential.id,
        }),
      )

      expect(result.isOk()).toBe(true)
      expect(refreshAccessToken).toHaveBeenCalledTimes(1)
      // The rotated access token is what gets injected into the provider —
      // never the old (now-expired) one.
      expect(vi.mocked(createMcpProvider)).toHaveBeenCalledWith(
        platform.connection,
        "rotated-access-token",
      )

      // The rotation persisted: the credential's secretRef now points at a
      // fresh ref holding the rotated token.
      const refetch = await repos.credentials.get(credential.id)
      expect(refetch.isOk()).toBe(true)
      if (refetch.isOk()) {
        const newToken = await store.get(refetch.value.secretRef)
        expect(newToken.isOk() && newToken.value).toBe("rotated-access-token")
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Increment 44 (R1/R3) — provider-id resolution wired through resolve-provider
// at the makeResolveProvider integration level (real temp-home DB, real
// oauthRefreshFn call via the mocked arctic client).
// ---------------------------------------------------------------------------

describe("makeResolveProvider — provider-id resolution (increment 44)", () => {
  beforeEach(() => {
    // The module-scope refreshAccessToken mock (hoisted above) is shared
    // across every test in this file — reset its call log so each test's
    // assertions are about ITS OWN call, not an accumulated count.
    refreshAccessToken.mockReset()
  })

  async function setUpOAuthCredential(opts: {
    idSuffix: string
    platformOauthProviderId?: string
    legacyProviderId?: string
  }) {
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) throw dbResult.error
    const repos = createRepositories(dbResult.value)

    const platformId = `oauth-platform-44-${opts.idSuffix}`
    const platform = PlatformSchema.parse({
      id: PlatformIdSchema.parse(platformId),
      kind: "mcp" as const,
      displayName: "OAuth MCP 44",
      connection: { transport: "http" as const, url: "https://example.com/mcp" },
      ...(opts.platformOauthProviderId !== undefined
        ? { oauthProviderId: opts.platformOauthProviderId }
        : {}),
    })
    await repos.platforms.upsert(platform)

    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) throw storeResult.error
    const store = storeResult.value

    const accessRef = `access-ref-44-${opts.idSuffix}`
    const refreshRef = `refresh-ref-44-${opts.idSuffix}`
    const clientIdRef = `client-id-ref-44-${opts.idSuffix}`
    const clientSecretRef = `client-secret-ref-44-${opts.idSuffix}`
    await store.set(accessRef, "old-access-token")
    await store.set(refreshRef, "old-refresh-token")
    await store.set(clientIdRef, "byo-client-id")
    await store.set(clientSecretRef, "byo-client-secret")

    const expiredAt = new Date(Date.now() - 1000).toISOString()
    const credentialId = `oauth-cred-44-${opts.idSuffix}`
    const createResult = await repos.credentials.create({
      id: credentialId,
      name: `work-${credentialId}`,
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: accessRef,
      oauthMeta: {
        refreshTokenRef: refreshRef,
        clientIdRef,
        clientSecretRef,
        ...(opts.legacyProviderId !== undefined ? { providerId: opts.legacyProviderId } : {}),
        authMode: "authorization_code",
        expiresAt: expiredAt,
        needsReauth: false,
      },
    })
    if (createResult.isErr()) throw createResult.error

    const { createMcpProvider } = await import("@junction/mcp-client")
    const stubProvider: ToolProvider = {
      listTools: () => new ResultAsync(Promise.resolve(ok([]))),
      callTool: () => new ResultAsync(Promise.resolve(ok({ content: [] }))),
      close: vi.fn().mockResolvedValue(undefined),
    }
    vi.mocked(createMcpProvider).mockReturnValue(new ResultAsync(Promise.resolve(ok(stubProvider))))

    return { repos, store, paths, credential: createResult.value, platformId }
  }

  it("platform.oauthProviderId sources the refresh call, not the credential's legacy providerId", async () => {
    await withTempHome(async () => {
      const { repos, store, paths, credential, platformId } = await setUpOAuthCredential({
        idSuffix: "platform-wins",
        platformOauthProviderId: "github-app",
        legacyProviderId: "google", // deliberately wrong — must be ignored
      })

      refreshAccessToken.mockResolvedValueOnce({
        data: { access_token: "rotated", expires_in: 3600 },
        accessToken: () => "rotated",
        hasRefreshToken: () => false,
        accessTokenExpiresInSeconds: () => 3600,
        hasScopes: () => false,
      })

      const resolveProvider = makeResolveProvider(repos, store, paths, { logPrefix: "test44" })
      const result = await resolveProvider(
        sourceRef({ platformId: PlatformIdSchema.parse(platformId), credentialId: credential.id }),
      )

      expect(result.isOk()).toBe(true)
      expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    })
  })

  it("orphan-equivalent: falls back to the credential's legacy providerId when platform.oauthProviderId is unset, and the fallback log fires", async () => {
    await withTempHome(async () => {
      const logs: string[] = []
      const { repos, store, paths, credential, platformId } = await setUpOAuthCredential({
        idSuffix: "fallback",
        legacyProviderId: "github-app",
      })

      refreshAccessToken.mockResolvedValueOnce({
        data: { access_token: "rotated-fallback", expires_in: 3600 },
        accessToken: () => "rotated-fallback",
        hasRefreshToken: () => false,
        accessTokenExpiresInSeconds: () => 3600,
        hasScopes: () => false,
      })

      const resolveProvider = makeResolveProvider(repos, store, paths, {
        logPrefix: "test44fallback",
        log: (msg) => logs.push(msg),
      })
      const result = await resolveProvider(
        sourceRef({ platformId: PlatformIdSchema.parse(platformId), credentialId: credential.id }),
      )

      expect(result.isOk()).toBe(true)
      expect(refreshAccessToken).toHaveBeenCalledTimes(1)
      // The instrumented fallback log fired, tagged with context="refresh" and
      // this credential's id — ids only, never token material.
      const fallbackLog = logs.find((l) => l.includes("fell back to the credential's legacy"))
      expect(fallbackLog).toBeDefined()
      expect(fallbackLog).toContain("context=refresh")
      expect(fallbackLog).toContain(`credentialId=${credential.id}`)
      expect(fallbackLog).not.toContain("rotated-fallback")
      expect(fallbackLog).not.toContain("old-access-token")
    })
  })

  it("SECURITY: platform.oauthProviderId points at a nonexistent design → fails closed as auth-failed, refreshFn (arctic) is never called", async () => {
    await withTempHome(async () => {
      const { repos, store, paths, credential, platformId } = await setUpOAuthCredential({
        idSuffix: "dangling",
        platformOauthProviderId: "attacker-controlled-design",
        legacyProviderId: "github-app", // present — must be ignored, not used as a fallback
      })

      const resolveProvider = makeResolveProvider(repos, store, paths, {
        logPrefix: "test44dangle",
      })
      const result = await resolveProvider(
        sourceRef({ platformId: PlatformIdSchema.parse(platformId), credentialId: credential.id }),
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("auth-failed")
      }
      expect(refreshAccessToken).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// 33.1 fix 2 — resolve-provider's kind gate now matches build-provider's
// (mcp/openapi/graphql/http/cli), not just mcp/openapi. These three tests
// prove a graphql/http/cli SourceRef no longer hits "unsupported-source-kind"
// and instead reaches (and succeeds through) buildProvider — the same
// generic ResolvedSecret{kind, value} construction path mcp/openapi already
// used. No mocking needed: createGraphQlProvider/createHttpProvider/
// createCliProvider are all synchronous at CONSTRUCTION time (no network/
// sandbox call until listTools/callTool), so these exercise the real
// dispatch through buildProvider without opening a real connection.
// ---------------------------------------------------------------------------
describe("makeResolveProvider — 33.1 fix 2: kind gate widened to all 5 kinds", () => {
  it("graphql source: resolves to Ok(ToolProvider), NOT unsupported-source-kind (previously the narrow gate's failure mode)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("gql-platform"),
        kind: "graphql" as const,
        displayName: "GraphQL Source",
        graphql: {
          endpoint: "https://example.com/graphql",
          auth: { scheme: "bearer" as const },
        },
      })
      await repos.platforms.upsert(platform)

      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return
      const store = storeResult.value

      const addResult = await addCredential(
        { platformId: "gql-platform", account: "work", kind: "bearer", secret: "GQL_TOKEN" },
        platform,
        store,
        repos.credentials,
      )
      expect(addResult.isOk()).toBe(true)
      if (addResult.isErr()) return

      const resolveProvider = makeResolveProvider(repos, store, paths, { logPrefix: "test" })
      const result = await resolveProvider(
        sourceRef({
          platformId: PlatformIdSchema.parse("gql-platform"),
          credentialId: addResult.value.id,
        }),
      )
      expect(result.isOk()).toBe(true)
      if (result.isErr()) {
        // The load-bearing negative assertion: must NOT be the pre-fix
        // failure mode (the narrow kind gate returning unsupported-source-kind
        // BEFORE buildProvider is ever reached).
        expect(result.error.kind).not.toBe("unsupported-source-kind")
      }
    })
  })

  it("http source: resolves to Ok(ToolProvider), NOT unsupported-source-kind", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("http-platform"),
        kind: "http" as const,
        displayName: "HTTP Source",
        http: {
          baseUrl: "https://example.com/api",
          auth: { scheme: "bearer" as const },
          tools: [
            {
              name: "ping",
              description: "Ping the API",
              method: "GET" as const,
              path: "/ping",
              params: [],
            },
          ],
        },
      })
      await repos.platforms.upsert(platform)

      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return
      const store = storeResult.value

      const addResult = await addCredential(
        { platformId: "http-platform", account: "work", kind: "bearer", secret: "HTTP_TOKEN" },
        platform,
        store,
        repos.credentials,
      )
      expect(addResult.isOk()).toBe(true)
      if (addResult.isErr()) return

      const resolveProvider = makeResolveProvider(repos, store, paths, { logPrefix: "test" })
      const result = await resolveProvider(
        sourceRef({
          platformId: PlatformIdSchema.parse("http-platform"),
          credentialId: addResult.value.id,
        }),
      )
      expect(result.isOk()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).not.toBe("unsupported-source-kind")
      }
    })
  })

  it("cli source: resolves to Ok(ToolProvider) via the SAME ResolvedSecret{kind} path buildProvider uses for CliSecret env/file folding — proves resolve-provider didn't have to duplicate build-provider's cli-specific secret handling", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("cli-platform"),
        kind: "cli" as const,
        displayName: "CLI Source",
        cli: {
          tools: [
            {
              name: "greet",
              argv: [{ kind: "literal", value: "/bin/echo" }],
              args: [],
              policy: {
                cwd: "/tmp",
                readPaths: ["/tmp"],
                writePaths: [],
                allowNet: [],
                timeoutMs: 5000,
                envAllow: {},
              },
            },
          ],
          credentialEnvVar: "CLI_RESOLVE_TEST_CRED",
        },
      })
      await repos.platforms.upsert(platform)

      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return
      const store = storeResult.value

      const addResult = await addCredential(
        { platformId: "cli-platform", account: "work", kind: "env", secret: "CLI_ENV_SECRET" },
        platform,
        store,
        repos.credentials,
      )
      expect(addResult.isOk()).toBe(true)
      if (addResult.isErr()) return

      const resolveProvider = makeResolveProvider(repos, store, paths, { logPrefix: "test" })
      const result = await resolveProvider(
        sourceRef({
          platformId: PlatformIdSchema.parse("cli-platform"),
          credentialId: addResult.value.id,
        }),
      )
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        // The provider was actually built (has the ToolProvider shape) —
        // proves buildProvider's cli branch was reached and constructed
        // successfully with the resolved env-kind secret.
        expect(typeof result.value.provider.listTools).toBe("function")
        expect(typeof result.value.provider.callTool).toBe("function")
      }
      if (result.isErr()) {
        expect(result.error.kind).not.toBe("unsupported-source-kind")
      }
    })
  })

  it("mcp/openapi kinds are UNCHANGED: mcp still resolves exactly as before the widening (regression guard)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      expect(dbResult.isOk()).toBe(true)
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)

      const platform = PlatformSchema.parse({
        id: PlatformIdSchema.parse("mcp-unchanged"),
        kind: "mcp" as const,
        displayName: "MCP Unchanged",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
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

      const resolveProvider = makeResolveProvider(repos, storeResult.value, paths, {
        logPrefix: "test",
      })
      const result = await resolveProvider(
        sourceRef({ platformId: PlatformIdSchema.parse("mcp-unchanged") }),
      )
      expect(result.isOk()).toBe(true)
    })
  })
})
