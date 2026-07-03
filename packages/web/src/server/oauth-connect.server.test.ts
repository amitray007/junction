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
const storeSetMock = vi.fn()
const storeDeleteMock = vi.fn()
const buildAuthorizeUrlMock = vi.fn()
const exchangeCodeMock = vi.fn()
const persistOAuthTokensMock = vi.fn()

vi.mock("@junction/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/core")>()
  return {
    ...actual,
    getPaths: vi.fn(() => ({ home: "/fake" }) as ReturnType<typeof actual.getPaths>),
    getProvider: (...args: unknown[]) => getProviderMock(...args),
    createCredentialStore: vi.fn(
      () =>
        okAsync({
          get: vi.fn(),
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
        }) as unknown as ReturnType<typeof actual.createRepositories>,
    ),
  }
})

vi.mock("@junction/source-runtime", () => ({
  buildAuthorizeUrl: (...args: unknown[]) => buildAuthorizeUrlMock(...args),
  exchangeCode: (...args: unknown[]) => exchangeCodeMock(...args),
  persistOAuthTokens: (...args: unknown[]) => persistOAuthTokensMock(...args),
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
  tokenAuthMethod: "client_secret_basic" as const,
  bodyFormat: "form" as const,
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

afterEach(() => {
  getProviderMock.mockReset()
  credentialsGetMock.mockReset()
  credentialsCreateMock.mockReset()
  setOAuthTokensMock.mockReset()
  storeSetMock.mockReset()
  storeDeleteMock.mockReset()
  buildAuthorizeUrlMock.mockReset()
  exchangeCodeMock.mockReset()
  persistOAuthTokensMock.mockReset()
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
})
