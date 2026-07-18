// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for oauth-connect.server.ts (inc 29, slice C) — startConnect,
// startReconnect, completeOAuthCallback. @junction/core and
// @junction/source-runtime are mocked (mirrors mutations.server.test.ts's
// pattern) so these run without a real DB/keyring/HTTP.
//
// SECURITY-FOCUSED ASSERTIONS: startConnect/startReconnect return {authorizeUrl}
// metadata only — a sentinel clientSecret seeded in the input must never appear
// in ANY returned value (the adversarial secret-absence sweep, per the brief).

import { errAsync, okAsync } from "neverthrow"
import { afterEach, describe, expect, it, vi } from "vitest"

const getProviderMock = vi.fn()
const credentialsGetMock = vi.fn()
const credentialsCreateMock = vi.fn()
const setOAuthTokensMock = vi.fn()
const platformsGetMock = vi.fn()
const platformsUpsertMock = vi.fn()
const platformsDeleteMock = vi.fn()
const storeSetMock = vi.fn()
const storeDeleteMock = vi.fn()
const storeGetMock = vi.fn()
const buildAuthorizeUrlMock = vi.fn()
const exchangeCodeMock = vi.fn()
const persistOAuthTokensMock = vi.fn()
const checkCollisionMock = vi.fn()
const assemblePlatformMock = vi.fn()
const getCatalogEntryMock = vi.fn()
const planConnectMock = vi.fn()

vi.mock("@junction/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/core")>()
  return {
    ...actual,
    getPaths: vi.fn(() => ({ home: "/fake" }) as ReturnType<typeof actual.getPaths>),
    getProvider: (...args: unknown[]) => getProviderMock(...args),
    getCatalogEntry: (...args: unknown[]) => getCatalogEntryMock(...args),
    planConnect: (...args: unknown[]) => planConnectMock(...args),
    createCredentialStore: vi.fn(
      () =>
        okAsync({
          get: storeGetMock,
          set: storeSetMock,
          delete: storeDeleteMock,
        }) as unknown as ReturnType<typeof actual.createCredentialStore>,
    ),
    createRepositories: vi.fn(
      () =>
        ({
          credentials: {
            get: credentialsGetMock,
            create: credentialsCreateMock,
            setOAuthTokens: setOAuthTokensMock,
          },
          platforms: {
            get: platformsGetMock,
            upsert: platformsUpsertMock,
            delete: platformsDeleteMock,
          },
        }) as unknown as ReturnType<typeof actual.createRepositories>,
    ),
  }
})

vi.mock("@junction/source-runtime", () => ({
  buildAuthorizeUrl: (...args: unknown[]) => buildAuthorizeUrlMock(...args),
  exchangeCode: (...args: unknown[]) => exchangeCodeMock(...args),
  persistOAuthTokens: (...args: unknown[]) => persistOAuthTokensMock(...args),
  checkCollision: (...args: unknown[]) => checkCollisionMock(...args),
  assemblePlatform: (...args: unknown[]) => assemblePlatformMock(...args),
}))

vi.mock("./shared.server.js", () => ({
  getDb: vi.fn(async () => ({})),
}))

const { startConnect, startReconnect, completeOAuthCallback } = await import(
  "./oauth-connect.server.js"
)
const { _clearPendingForTests, _pendingSizeForTests, takePending } = await import(
  "./pending-auth.server.js"
)

const GITHUB_PROVIDER = {
  id: "github",
  displayName: "GitHub",
  authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  pkce: "S256" as const,
  scopeSeparator: " " as const,
  expiryStrategy: "none" as const,
  redirectMode: "loopback-fixed" as const,
  supportsRefresh: false,
  registrationHint: {
    redirectUri: "http://127.0.0.1:4321/oauth/callback",
    scopes: "repo",
    docsUrl: "https://docs.github.com",
  },
}

const SENTINEL_SECRET = "sentinel-client-secret-do-not-leak-xyz123"
// A distinct sentinel for the stored client_secret (reconnect-reuse path).
const STORED_CLIENT_SECRET = "stored-client-secret-do-not-leak-abc789" // gitleaks:allow

afterEach(() => {
  getProviderMock.mockReset()
  credentialsGetMock.mockReset()
  credentialsCreateMock.mockReset()
  setOAuthTokensMock.mockReset()
  platformsGetMock.mockReset()
  platformsUpsertMock.mockReset()
  platformsDeleteMock.mockReset()
  storeSetMock.mockReset()
  storeDeleteMock.mockReset()
  storeGetMock.mockReset()
  buildAuthorizeUrlMock.mockReset()
  exchangeCodeMock.mockReset()
  persistOAuthTokensMock.mockReset()
  checkCollisionMock.mockReset()
  assemblePlatformMock.mockReset()
  getCatalogEntryMock.mockReset()
  planConnectMock.mockReset()
  _clearPendingForTests()
})

// ---------------------------------------------------------------------------
// startConnect
// ---------------------------------------------------------------------------

describe("startConnect", () => {
  it("returns {authorizeUrl} and stashes a pending entry keyed by state", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize?client_id=abc",
      state: "state-xyz",
      codeVerifier: "verifier-xyz",
    })

    const result = await startConnect({
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      platformId: "github-platform",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.authorizeUrl).toBe("https://github.com/login/oauth/authorize?client_id=abc")

    const pending = takePending("state-xyz")
    expect(pending).toBeDefined()
    expect(pending?.providerId).toBe("github")
    expect(pending?.clientSecret).toBe(SENTINEL_SECRET)
    expect(pending?.intent).toEqual({
      mode: "create",
      platformId: "github-platform",
      account: "work",
    })
  })

  it("the sentinel client secret never appears in the returned value (adversarial sweep)", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize?client_id=abc",
      state: "state-xyz",
      codeVerifier: "verifier-xyz",
    })

    const result = await startConnect({
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      platformId: "github-platform",
    })

    expect(JSON.stringify(result)).not.toContain(SENTINEL_SECRET)
    expect(JSON.stringify(result)).not.toContain("state-xyz")
    expect(JSON.stringify(result)).not.toContain("verifier-xyz")
  })

  it("returns an error for an unknown providerId (no pending entry stashed)", async () => {
    getProviderMock.mockReturnValue(undefined)

    const result = await startConnect({
      providerId: "not-a-real-provider",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: [],
      account: "work",
      platformId: "github-platform",
    })

    expect(result.ok).toBe(false)
    expect(buildAuthorizeUrlMock).not.toHaveBeenCalled()
    expect(_pendingSizeForTests()).toBe(0)
  })

  it("stores codeVerifier as null when the provider disables PKCE", async () => {
    getProviderMock.mockReturnValue({ ...GITHUB_PROVIDER, pkce: "disabled" as const })
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://example.com/authorize",
      state: "state-nopkce",
      codeVerifier: "unused-verifier",
    })

    await startConnect({
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: [],
      account: "work",
      platformId: "github-platform",
    })

    const pending = takePending("state-nopkce")
    expect(pending?.codeVerifier).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// startConnect — surfaceSelector (inc 38 D2; re-derivation fixed post-38): a
// catalog-originated connect supplies a MINIMAL selector
// ({appId, surfaceKind, authMode}), never an assembled platformInput.
// startConnect re-derives platformId/platformInput/displayName from the
// catalog itself (getCatalogEntry + planConnect, mocked here), then
// collision-pre-checks BEFORE the redirect.
// ---------------------------------------------------------------------------

const MCP_PLATFORM_INPUT = {
  kind: "mcp" as const,
  transport: "http" as const,
  url: "https://example.com/mcp",
  authHeader: undefined,
  command: undefined,
  args: undefined,
  tokenEnvVar: undefined,
  env: undefined,
}

// The catalog's REAL (authoritative) GitHub MCP surface + entry, keyed by the
// selector {appId:"github", surfaceKind:"mcp"} — used to prove startConnect
// re-derives from the catalog rather than trusting anything client-supplied.
const GITHUB_ENTRY = {
  id: "github",
  displayName: "GitHub",
  surfaces: [
    {
      kind: "mcp",
      displayName: "GitHub MCP",
      auth: [{ mode: "oauth2", providerId: "github" }],
    },
  ],
} as unknown as Parameters<typeof planConnectMock>[0]

function mockCatalogPlanConnect(overrides?: {
  platformId?: string
  platformInput?: typeof MCP_PLATFORM_INPUT
  displayName?: string
}) {
  getCatalogEntryMock.mockReturnValue(GITHUB_ENTRY)
  planConnectMock.mockReturnValue({
    path: "oauth-handoff",
    providerId: "github",
    platformId: overrides?.platformId ?? "github-mcp",
    platformInput: overrides?.platformInput ?? MCP_PLATFORM_INPUT,
    displayName: overrides?.displayName ?? "GitHub MCP",
  })
}

describe("startConnect — surfaceSelector (inc 38 D2, re-derivation fixed post-38)", () => {
  it("neither platformId nor surfaceSelector: fails, no redirect built", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)

    const result = await startConnect({
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      // both OMITTED.
    })

    expect(result.ok).toBe(false)
    expect(buildAuthorizeUrlMock).not.toHaveBeenCalled()
  })

  it("platformId (raw /credentials flow): checkCollision is never called, getCatalogEntry/planConnect are never called (must-stay-working — byte-identical)", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize",
      state: "state-no-surface",
      codeVerifier: "verifier",
    })

    const result = await startConnect({
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      platformId: "github-platform",
      // surfaceSelector OMITTED.
    })

    expect(result.ok).toBe(true)
    expect(checkCollisionMock).not.toHaveBeenCalled()
    expect(getCatalogEntryMock).not.toHaveBeenCalled()
    expect(planConnectMock).not.toHaveBeenCalled()
    const pending = takePending("state-no-surface")
    expect(pending?.intent).toEqual({
      mode: "create",
      platformId: "github-platform",
      account: "work",
    })
  })

  it("surfaceSelector present + no collision: re-derives platformInput from the catalog, pre-checks BEFORE the redirect, then stashes the SERVER-DERIVED surfacePlatform in the pending create-intent", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    mockCatalogPlanConnect()
    checkCollisionMock.mockReturnValue(okAsync({ existing: undefined }))
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize",
      state: "state-surface-ok",
      codeVerifier: "verifier",
    })

    const result = await startConnect({
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      surfaceSelector: { appId: "github", surfaceKind: "mcp", authMode: "oauth2" },
    })

    expect(result.ok).toBe(true)
    expect(getCatalogEntryMock).toHaveBeenCalledWith("github")
    expect(planConnectMock).toHaveBeenCalledWith(GITHUB_ENTRY, GITHUB_ENTRY.surfaces[0], {
      authMode: "oauth2",
    })
    expect(checkCollisionMock).toHaveBeenCalledWith(expect.anything(), "github-mcp", "mcp")
    // Collision check happens BEFORE buildAuthorizeUrl (never strand a grant
    // by redirecting first) — proven by call ORDER via mock.invocationCallOrder.
    const collisionOrder = checkCollisionMock.mock.invocationCallOrder[0]
    const redirectOrder = buildAuthorizeUrlMock.mock.invocationCallOrder[0]
    expect(collisionOrder).toBeLessThan(redirectOrder as number)

    const pending = takePending("state-surface-ok")
    expect(pending?.intent).toEqual({
      mode: "create",
      platformId: "github-mcp",
      account: "work",
      surfacePlatform: { platformInput: MCP_PLATFORM_INPUT, displayName: "GitHub MCP" },
    })
  })

  it("REGRESSION (trust-boundary fix): a client-forged surfaceSelector cannot bind a hostile connection — startConnect ignores any client-supplied connection details and re-derives from the catalog only", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    // The catalog's REAL, authoritative GitHub MCP surface — the ONLY source
    // startConnect is allowed to read the connection from.
    mockCatalogPlanConnect({
      platformInput: {
        ...MCP_PLATFORM_INPUT,
        url: "https://api.github.com/mcp",
      },
    })
    checkCollisionMock.mockReturnValue(okAsync({ existing: undefined }))
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize",
      state: "state-forged",
      codeVerifier: "verifier",
    })

    // The attack: the request body is CONSTRUCTED here exactly as an
    // attacker-controlled client (or a MITM'd fetch call) would send it — an
    // ATTACKER-CHOSEN baseUrl/platformInput smuggled in under a legitimate
    // selector.  With the fixed contract, StartConnectInput has NO field that
    // can carry this at all (surfaceSelector is {appId, surfaceKind,
    // authMode} ONLY) — so this is expressed as "even if extra properties are
    // attached to the wire payload, startConnect's typed input never reads
    // them" by casting the malicious extra field through `unknown`.
    const forgedInput = {
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      surfaceSelector: { appId: "github", surfaceKind: "mcp", authMode: "oauth2" as const },
      // Attacker-supplied extra property — NOT part of StartConnectInput's
      // type, simulating a raw/forged request body that tries to smuggle a
      // hostile platformInput past the selector.
      platformInput: { kind: "mcp", transport: "http", url: "https://attacker.example.com/mcp" },
    }

    const result = await startConnect(forgedInput as Parameters<typeof startConnect>[0])

    expect(result.ok).toBe(true)
    // The ONLY platformInput ever reaches checkCollision/pending-auth is the
    // one planConnect derived from the catalog — the attacker's baseUrl never
    // appears anywhere.
    const pending = takePending("state-forged")
    expect(pending?.intent).toEqual({
      mode: "create",
      platformId: "github-mcp",
      account: "work",
      surfacePlatform: {
        platformInput: { ...MCP_PLATFORM_INPUT, url: "https://api.github.com/mcp" },
        displayName: "GitHub MCP",
      },
    })
    // The attacker's URL must never appear anywhere in what gets persisted.
    expect(JSON.stringify(pending)).not.toContain("attacker.example.com")
  })

  it("surfaceSelector with an unknown appId: fails closed (unknown-surface), never redirects", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    getCatalogEntryMock.mockReturnValue(undefined)

    const result = await startConnect({
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      surfaceSelector: { appId: "not-a-real-app", surfaceKind: "mcp", authMode: "oauth2" },
    })

    expect(result.ok).toBe(false)
    expect(buildAuthorizeUrlMock).not.toHaveBeenCalled()
    expect(_pendingSizeForTests()).toBe(0)
  })

  it("surfaceSelector present + platform-kind conflict: fails BEFORE the redirect — never strands a grant", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    mockCatalogPlanConnect()
    checkCollisionMock.mockReturnValue(
      errAsync({ kind: "platform-kind-conflict", existingKind: "openapi", requestedKind: "mcp" }),
    )

    const result = await startConnect({
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      surfaceSelector: { appId: "github", surfaceKind: "mcp", authMode: "oauth2" },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect("conflict" in result && result.conflict.existingKind).toBe("openapi")
    // No redirect was ever built, no pending state stashed — the grant was
    // never started.
    expect(buildAuthorizeUrlMock).not.toHaveBeenCalled()
    expect(_pendingSizeForTests()).toBe(0)
  })

  it("the sentinel client secret never appears in a conflict result (adversarial sweep)", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    mockCatalogPlanConnect()
    checkCollisionMock.mockReturnValue(
      errAsync({ kind: "platform-kind-conflict", existingKind: "openapi", requestedKind: "mcp" }),
    )

    const result = await startConnect({
      providerId: "github",
      clientId: "client-abc",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      surfaceSelector: { appId: "github", surfaceKind: "mcp", authMode: "oauth2" },
    })

    expect(JSON.stringify(result)).not.toContain(SENTINEL_SECRET)
  })
})

// ---------------------------------------------------------------------------
// startReconnect
// ---------------------------------------------------------------------------

describe("startReconnect", () => {
  it("reads providerId/scopes from the existing credential's oauthMeta and stashes mode:update", async () => {
    credentialsGetMock.mockReturnValue(
      okAsync({
        id: "cred-1",
        platformId: "github-platform",
        profileName: "work",
        kind: "oauth2",
        secretRef: "ref-access",
        oauthMeta: { providerId: "github", scopes: ["repo"], needsReauth: true },
      }),
    )
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize?reconnect=1",
      state: "state-reconnect",
      codeVerifier: "verifier-reconnect",
    })

    const result = await startReconnect({
      credentialId: "cred-1",
      clientId: "client-new",
      clientSecret: SENTINEL_SECRET,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.authorizeUrl).toBe("https://github.com/login/oauth/authorize?reconnect=1")
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SECRET)

    const pending = takePending("state-reconnect")
    expect(pending?.intent).toEqual({ mode: "update", credentialId: "cred-1" })
    expect(pending?.scopes).toEqual(["repo"])
  })

  it("REUSES stored client creds when none are supplied (no re-typing) — resolves clientIdRef/clientSecretRef from the store", async () => {
    credentialsGetMock.mockReturnValue(
      okAsync({
        id: "cred-reuse",
        platformId: "github-platform",
        profileName: "work",
        kind: "oauth2",
        secretRef: "ref-access",
        oauthMeta: {
          providerId: "github",
          scopes: ["repo"],
          needsReauth: true,
          clientIdRef: "ref-client-id",
          clientSecretRef: "ref-client-secret",
        },
      }),
    )
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    // The store resolves the stored client creds — this is the whole point.
    // Only the EXACT stored refs succeed; any other ref resolves to null (a lost
    // secret), so the test fails loudly if the impl reads the wrong ref.
    storeGetMock.mockImplementation((ref: string) => {
      if (ref === "ref-client-id") return okAsync("stored-client-id")
      if (ref === "ref-client-secret") return okAsync(STORED_CLIENT_SECRET)
      return okAsync(null)
    })
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize?reuse=1",
      state: "state-reuse",
      codeVerifier: "verifier-reuse",
    })

    // NO clientId/clientSecret in the input → reuse path.
    const result = await startReconnect({ credentialId: "cred-reuse" })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.authorizeUrl).toBe("https://github.com/login/oauth/authorize?reuse=1")
    // The stored client_secret must NEVER appear in the returned value.
    expect(JSON.stringify(result)).not.toContain(STORED_CLIENT_SECRET)
    // buildAuthorizeUrl was called with the STORED client_id (not re-typed).
    expect(buildAuthorizeUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "stored-client-id" }),
    )
    // The pending stash carries the resolved creds for the token exchange.
    const pending = takePending("state-reuse")
    expect(pending?.clientId).toBe("stored-client-id")
    expect(pending?.clientSecret).toBe(STORED_CLIENT_SECRET)
  })

  it("errors when reusing but the credential has no stored client refs", async () => {
    credentialsGetMock.mockReturnValue(
      okAsync({
        id: "cred-norefs",
        platformId: "github-platform",
        profileName: "work",
        kind: "oauth2",
        secretRef: "ref-access",
        // no clientIdRef/clientSecretRef
        oauthMeta: { providerId: "github", scopes: ["repo"], needsReauth: true },
      }),
    )
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)

    const result = await startReconnect({ credentialId: "cred-norefs" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toContain("no stored client credentials")
  })

  it("rejects a PARTIAL swap (clientId without clientSecret) rather than silently reusing", async () => {
    credentialsGetMock.mockReturnValue(
      okAsync({
        id: "cred-partial",
        platformId: "github-platform",
        profileName: "work",
        kind: "oauth2",
        secretRef: "ref-access",
        oauthMeta: {
          providerId: "github",
          scopes: ["repo"],
          needsReauth: true,
          clientIdRef: "ref-client-id",
          clientSecretRef: "ref-client-secret",
        },
      }),
    )
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)

    // Only clientId — no clientSecret. Must error, NOT silently reuse the stored pair.
    const result = await startReconnect({ credentialId: "cred-partial", clientId: "typed-id" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toContain("both client ID and client secret")
    // The store was never consulted (no silent swap).
    expect(storeGetMock).not.toHaveBeenCalled()
  })

  it("returns an error when the credential has no oauth provider on file", async () => {
    credentialsGetMock.mockReturnValue(
      okAsync({
        id: "cred-2",
        platformId: "p",
        profileName: "work",
        kind: "bearer",
        secretRef: "ref-1",
      }),
    )

    const result = await startReconnect({
      credentialId: "cred-2",
      clientId: "client-new",
      clientSecret: SENTINEL_SECRET,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toMatch(/no oauth provider/i)
  })

  it("returns an error when the credential doesn't exist", async () => {
    credentialsGetMock.mockReturnValue(
      errAsync({ kind: "not-found", entity: "credential", id: "x" }),
    )

    const result = await startReconnect({
      credentialId: "missing",
      clientId: "client-new",
      clientSecret: SENTINEL_SECRET,
    })

    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// completeOAuthCallback — the callback loader's single-use state consumption
// ---------------------------------------------------------------------------

describe("completeOAuthCallback", () => {
  async function seedPendingCreate(state: string) {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize",
      state,
      codeVerifier: "verifier-seed",
    })
    await startConnect({
      providerId: "github",
      clientId: "client-1",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      platformId: "github-platform",
    })
  }

  it("valid state → exchange + persist + ok outcome", async () => {
    await seedPendingCreate("state-ok")
    // exchangeCode returns a plain Promise<Result<...>> (not ResultAsync) per its
    // real signature — resolve directly to the neverthrow Result shape.
    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access", refreshToken: "tok-refresh" },
    })
    persistOAuthTokensMock.mockReturnValue(
      okAsync({ id: "cred-new", platformId: "github-platform", profileName: "work" }),
    )

    const result = await completeOAuthCallback("code-123", "state-ok")
    expect(result.outcome).toBe("ok")
    expect(exchangeCodeMock).toHaveBeenCalledOnce()
    expect(persistOAuthTokensMock).toHaveBeenCalledOnce()
  })

  it("unknown state → error-state outcome, no exchange/persist attempted", async () => {
    const result = await completeOAuthCallback("code-123", "never-seeded-state")
    expect(result.outcome).toBe("error-state")
    expect(exchangeCodeMock).not.toHaveBeenCalled()
    expect(persistOAuthTokensMock).not.toHaveBeenCalled()
  })

  it("a REUSED (already-consumed) state → error-state on the second call, no double-persist", async () => {
    await seedPendingCreate("state-reuse")
    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access" },
    })
    persistOAuthTokensMock.mockReturnValue(
      okAsync({ id: "cred-new", platformId: "github-platform", profileName: "work" }),
    )

    const first = await completeOAuthCallback("code-123", "state-reuse")
    expect(first.outcome).toBe("ok")
    expect(persistOAuthTokensMock).toHaveBeenCalledTimes(1)

    const second = await completeOAuthCallback("code-123", "state-reuse")
    expect(second.outcome).toBe("error-state")
    // Still exactly once — the replay must NOT persist again.
    expect(persistOAuthTokensMock).toHaveBeenCalledTimes(1)
  })

  it("exchange failure → error outcome with a non-secret reason, no persist attempted", async () => {
    await seedPendingCreate("state-exchange-fail")
    exchangeCodeMock.mockResolvedValue({
      isErr: () => true,
      error: { kind: "exchange-failed", reason: "invalid_grant", detail: "invalid_grant" },
    })

    const result = await completeOAuthCallback("bad-code", "state-exchange-fail")
    expect(result.outcome).toBe("error")
    expect(persistOAuthTokensMock).not.toHaveBeenCalled()
    if (result.outcome === "error") {
      expect(result.reason).not.toContain(SENTINEL_SECRET)
    }
  })

  it("32.13 Slice B1: a duplicate-account persist failure -> error outcome with reason 'duplicate-account' (not generic 'persist-failed')", async () => {
    await seedPendingCreate("state-dup-account")
    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access" },
    })
    persistOAuthTokensMock.mockReturnValue(
      errAsync({ kind: "duplicate-account", platformId: "github-platform", account: "work" }),
    )

    const result = await completeOAuthCallback("code-123", "state-dup-account")
    expect(result.outcome).toBe("error")
    if (result.outcome === "error") {
      expect(result.reason).toBe("duplicate-account")
      expect(result.reason).not.toBe("persist-failed")
    }
  })

  it("the sentinel client secret never appears in any completeOAuthCallback outcome (adversarial sweep)", async () => {
    await seedPendingCreate("state-sweep")
    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access", refreshToken: "tok-refresh" },
    })
    persistOAuthTokensMock.mockReturnValue(
      okAsync({ id: "cred-new", platformId: "github-platform", profileName: "work" }),
    )

    const result = await completeOAuthCallback("code-123", "state-sweep")
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SECRET)
    expect(JSON.stringify(result)).not.toContain("state-sweep")
    expect(JSON.stringify(result)).not.toContain("verifier-seed")
    expect(JSON.stringify(result)).not.toContain("tok-access")
    expect(JSON.stringify(result)).not.toContain("tok-refresh")
  })

  it("must-stay-working: reconnect (mode:update) NEVER calls checkCollision/assemblePlatform — platformBuild is create-args-only", async () => {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    credentialsGetMock.mockReturnValue(
      okAsync({
        id: "cred-reconnect",
        platformId: "github-platform",
        profileName: "work",
        kind: "oauth2",
        secretRef: "ref-access",
        oauthMeta: { providerId: "github", scopes: ["repo"], needsReauth: true },
      }),
    )
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize?reconnect=1",
      state: "state-reconnect-cb",
      codeVerifier: "verifier-reconnect",
    })
    await startReconnect({
      credentialId: "cred-reconnect",
      clientId: "client-new",
      clientSecret: SENTINEL_SECRET,
    })

    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access" },
    })
    persistOAuthTokensMock.mockReturnValue(
      okAsync({ id: "cred-reconnect", platformId: "github-platform", profileName: "work" }),
    )

    const result = await completeOAuthCallback("code-123", "state-reconnect-cb")
    expect(result.outcome).toBe("ok")
    expect(checkCollisionMock).not.toHaveBeenCalled()
    expect(assemblePlatformMock).not.toHaveBeenCalled()
    // persistOAuthTokens was called with mode:"update" — no platformBuild key.
    const callArgs = persistOAuthTokensMock.mock.calls[0]?.[0]
    expect(callArgs.mode).toBe("update")
    expect(callArgs.platformBuild).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// completeOAuthCallback — increment 38 D1: the surfacePlatform → platformBuild
// bind. seedPendingCreateWithSurface mirrors seedPendingCreate but supplies a
// surfaceSelector (the guided oauth2 connect-panel flow) — startConnect
// re-derives the surfacePlatform payload from the (mocked) catalog.
// ---------------------------------------------------------------------------

describe("completeOAuthCallback — surfacePlatform bind (inc 38 D1)", () => {
  async function seedPendingCreateWithSurface(state: string, platformId = "github-mcp") {
    getProviderMock.mockReturnValue(GITHUB_PROVIDER)
    mockCatalogPlanConnect({ platformId })
    checkCollisionMock.mockReturnValueOnce(okAsync({ existing: undefined })) // the startConnect pre-check
    buildAuthorizeUrlMock.mockReturnValue({
      url: "https://github.com/login/oauth/authorize",
      state,
      codeVerifier: "verifier-seed",
    })
    await startConnect({
      providerId: "github",
      clientId: "client-1",
      clientSecret: SENTINEL_SECRET,
      scopes: ["repo"],
      account: "work",
      surfaceSelector: { appId: "github", surfaceKind: "mcp", authMode: "oauth2" },
    })
  }

  it("no collision at callback: assembles the Platform and passes platformBuild:{platform,preExisting:false} into persistOAuthTokens", async () => {
    await seedPendingCreateWithSurface("state-bind-ok")
    checkCollisionMock.mockReturnValueOnce(okAsync({ existing: undefined })) // the callback re-check
    const assembledPlatform = {
      id: "github-mcp",
      kind: "mcp" as const,
      displayName: "GitHub MCP",
      connection: { transport: "http" as const, url: "https://example.com/mcp" },
    }
    assemblePlatformMock.mockReturnValue(okAsync(assembledPlatform))
    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access", refreshToken: "tok-refresh" },
    })
    persistOAuthTokensMock.mockReturnValue(
      okAsync({ id: "cred-new", platformId: "github-mcp", profileName: "work" }),
    )

    const result = await completeOAuthCallback("code-123", "state-bind-ok")
    expect(result.outcome).toBe("ok")
    expect(assemblePlatformMock).toHaveBeenCalledWith(
      "github-mcp",
      "GitHub MCP",
      MCP_PLATFORM_INPUT,
    )
    const callArgs = persistOAuthTokensMock.mock.calls[0]?.[0]
    expect(callArgs.mode).toBe("create")
    expect(callArgs.platformBuild).toEqual({ platform: assembledPlatform, preExisting: false })
  })

  it("a collision found at the callback RE-CHECK (state changed during the round-trip): errors WITHOUT calling persistOAuthTokens", async () => {
    await seedPendingCreateWithSurface("state-bind-recheck-conflict")
    checkCollisionMock.mockReturnValueOnce(
      errAsync({ kind: "platform-kind-conflict", existingKind: "openapi", requestedKind: "mcp" }),
    )
    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access" },
    })

    const result = await completeOAuthCallback("code-123", "state-bind-recheck-conflict")
    expect(result.outcome).toBe("error")
    if (result.outcome === "error") expect(result.reason).toBe("platform-kind-conflict")
    expect(persistOAuthTokensMock).not.toHaveBeenCalled()
  })

  it("preExisting collision (same-kind platform already there): platformBuild carries preExisting:true", async () => {
    await seedPendingCreateWithSurface("state-bind-preexisting")
    const existingPlatform = {
      id: "github-mcp",
      kind: "mcp" as const,
      displayName: "Already Here",
      connection: { transport: "http" as const, url: "https://example.com/mcp" },
    }
    checkCollisionMock.mockReturnValueOnce(okAsync({ existing: existingPlatform }))
    const assembledPlatform = {
      id: "github-mcp",
      kind: "mcp" as const,
      displayName: "GitHub MCP",
      connection: { transport: "http" as const, url: "https://example.com/mcp" },
    }
    assemblePlatformMock.mockReturnValue(okAsync(assembledPlatform))
    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access" },
    })
    persistOAuthTokensMock.mockReturnValue(
      okAsync({ id: "cred-new", platformId: "github-mcp", profileName: "work" }),
    )

    const result = await completeOAuthCallback("code-123", "state-bind-preexisting")
    expect(result.outcome).toBe("ok")
    const callArgs = persistOAuthTokensMock.mock.calls[0]?.[0]
    expect(callArgs.platformBuild).toEqual({ platform: assembledPlatform, preExisting: true })
  })

  it("assemblePlatform failure: errors WITHOUT calling persistOAuthTokens (rare — bad catalog data)", async () => {
    await seedPendingCreateWithSurface("state-bind-assemble-fail")
    checkCollisionMock.mockReturnValueOnce(okAsync({ existing: undefined }))
    assemblePlatformMock.mockReturnValue(
      errAsync({ kind: "assemble-failed", cause: { kind: "unsupported-kind" } }),
    )
    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access" },
    })

    const result = await completeOAuthCallback("code-123", "state-bind-assemble-fail")
    expect(result.outcome).toBe("error")
    if (result.outcome === "error") expect(result.reason).toBe("assemble-failed")
    expect(persistOAuthTokensMock).not.toHaveBeenCalled()
  })

  it("the sentinel client secret never appears in a surfacePlatform-bind outcome (adversarial sweep)", async () => {
    await seedPendingCreateWithSurface("state-bind-sweep")
    checkCollisionMock.mockReturnValueOnce(okAsync({ existing: undefined }))
    assemblePlatformMock.mockReturnValue(
      okAsync({
        id: "github-mcp",
        kind: "mcp" as const,
        displayName: "GitHub MCP",
        connection: { transport: "http" as const, url: "https://example.com/mcp" },
      }),
    )
    exchangeCodeMock.mockResolvedValue({
      isErr: () => false,
      value: { accessToken: "tok-access", refreshToken: "tok-refresh" },
    })
    persistOAuthTokensMock.mockReturnValue(
      okAsync({ id: "cred-new", platformId: "github-mcp", profileName: "work" }),
    )

    const result = await completeOAuthCallback("code-123", "state-bind-sweep")
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SECRET)
  })
})
