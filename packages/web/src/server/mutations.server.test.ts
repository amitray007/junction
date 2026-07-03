// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for mutations.server.ts's mutateAddCredential platform-lookup error
// mapping (correctness-review fix: a non-not-found platforms.get error kind must
// not collapse to the same "Platform not found" message as an actual missing row).
//
// createRepositories/createCredentialStore/getDb are mocked so this test can force
// a deterministic non-not-found DbError from platforms.get without needing to
// engineer a real sqlite-level failure — mutateAddCredential returns before ever
// touching addCredential/the store on this path, so the mock only needs to cover
// the platform lookup.

import { errAsync, okAsync } from "neverthrow"
import { afterEach, describe, expect, it, vi } from "vitest"

const getMock = vi.fn()
const credentialsGetMock = vi.fn()
const setVerifyStateMock = vi.fn()
const storeGetMock = vi.fn()
const storeSetMock = vi.fn()
const credentialsCreateMock = vi.fn()
const verifyCredentialMock = vi.fn()

vi.mock("@junction/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/core")>()
  return {
    ...actual,
    getPaths: vi.fn(() => ({ home: "/fake" }) as ReturnType<typeof actual.getPaths>),
    createCredentialStore: vi.fn(
      () =>
        okAsync({ get: storeGetMock, set: storeSetMock }) as unknown as ReturnType<
          typeof actual.createCredentialStore
        >,
    ),
    createRepositories: vi.fn(
      () =>
        ({
          platforms: { get: getMock },
          credentials: {
            get: credentialsGetMock,
            setVerifyState: setVerifyStateMock,
            create: credentialsCreateMock,
          },
        }) as unknown as ReturnType<typeof actual.createRepositories>,
    ),
  }
})

vi.mock("@junction/source-runtime", () => ({
  verifyCredential: (...args: unknown[]) => verifyCredentialMock(...args),
}))

vi.mock("./shared.server.js", () => ({
  getDb: vi.fn(async () => ({})),
}))

const { mutateAddCredential, testCredential } = await import("./mutations.server.js")

afterEach(() => {
  getMock.mockReset()
  credentialsGetMock.mockReset()
  setVerifyStateMock.mockReset()
  storeGetMock.mockReset()
  storeSetMock.mockReset()
  credentialsCreateMock.mockReset()
  verifyCredentialMock.mockReset()
})

describe("mutateAddCredential — platform lookup error mapping", () => {
  it('returns "Platform not found" when platforms.get errs with kind "not-found"', async () => {
    getMock.mockReturnValue(errAsync({ kind: "not-found", entity: "platform", id: "missing" }))

    const result = await mutateAddCredential({
      platformId: "missing",
      account: "acct",
      kind: "bearer",
      secret: "sekrit",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("Platform not found")
  })

  it('maps a non-not-found platforms.get error kind (e.g. "query-failed") to "Database error"', async () => {
    getMock.mockReturnValue(errAsync({ kind: "query-failed", cause: new Error("disk I/O error") }))

    const result = await mutateAddCredential({
      platformId: "whatever",
      account: "acct",
      kind: "bearer",
      secret: "sekrit",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("Database error")
  })
})

// ---------------------------------------------------------------------------
// mutateAddCredential — verify-on-add (28.9). A platform whose kind-compat
// matrix accepts "bearer" (mcp stdio: ["env", "bearer"]) so the real
// addCredential/isKindAccepted validation passes without mocking core's
// kind-compat logic. store.set + credentials.create are mocked to let the
// real addCredential flow through to completion, then verifyCredential runs.
// ---------------------------------------------------------------------------

const verifyOnAddPlatform = {
  id: "mcp-plat",
  kind: "mcp",
  displayName: "Test MCP",
  connection: { transport: "stdio", command: "some-cmd" },
}

describe("mutateAddCredential — verify-on-add secret discipline", () => {
  it("never leaks the plaintext secret or secretRef through the verify=true success result (stringify guard)", async () => {
    getMock.mockReturnValue(okAsync(verifyOnAddPlatform))
    storeSetMock.mockReturnValue(okAsync(undefined))
    credentialsCreateMock.mockImplementation((c: { id: string }) => okAsync(c))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await mutateAddCredential({
      platformId: "mcp-plat",
      account: "acct",
      kind: "bearer",
      secret: "super-secret-plaintext-value",
      verify: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.verify).toEqual({ status: "ok" })

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("super-secret-plaintext-value")
    expect(serialized).not.toContain("secretRef")
  })
})

// ---------------------------------------------------------------------------
// testCredential — 28.9 Test Connection. Mocks the repo/store/verify layers
// per this file's established pattern (mutateAddCredential's platform-lookup
// suite above) rather than engineering a real sqlite/keyring/network failure.
// ---------------------------------------------------------------------------

const fakePlatform = { id: "plat-1", kind: "mcp", displayName: "Test" } as unknown as Parameters<
  typeof verifyCredentialMock
>[0]
const fakeCredentialRow = { id: "cred-1", platformId: "plat-1", secretRef: "ref-1" }

describe("testCredential", () => {
  it('returns {ok:true, status:"ok"} and persists setVerifyState on a real ok verify', async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("plaintext-secret"))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")

    expect(result).toEqual({ ok: true, status: "ok" })
    expect(setVerifyStateMock).toHaveBeenCalledWith("cred-1", "ok", expect.any(Number))
  })

  it('returns {ok:true, status:"auth-failed"} and persists it', async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("plaintext-secret"))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "auth-failed" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")

    expect(result).toEqual({ ok: true, status: "auth-failed" })
    expect(setVerifyStateMock).toHaveBeenCalledWith("cred-1", "auth-failed", expect.any(Number))
  })

  it('returns {ok:true, status:"unreachable", detail} and persists "unreachable" (no secret/URL in detail)', async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("plaintext-secret"))
    verifyCredentialMock.mockReturnValue(
      okAsync({ status: "unreachable", detail: "connect-failed: TypeError" }),
    )
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")

    expect(result).toEqual({
      ok: true,
      status: "unreachable",
      detail: "connect-failed: TypeError",
    })
    expect(setVerifyStateMock).toHaveBeenCalledWith("cred-1", "unreachable", expect.any(Number))
    // No secret and no URL-shaped substring anywhere in the returned detail.
    expect(result.ok && result.detail).not.toMatch(/plaintext-secret|https?:\/\//)
  })

  it('returns {ok:true, status:"not-verifiable", detail:reason} WITHOUT persisting (not-verifiable is never an event)', async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("plaintext-secret"))
    verifyCredentialMock.mockReturnValue(
      okAsync({ status: "not-verifiable", reason: "running a command has side effects" }),
    )

    const result = await testCredential("cred-1")

    expect(result).toEqual({
      ok: true,
      status: "not-verifiable",
      detail: "running a command has side effects",
    })
    expect(setVerifyStateMock).not.toHaveBeenCalled()
  })

  it("returns a clean {ok:false} when the credential row is not found (no throw)", async () => {
    credentialsGetMock.mockReturnValue(errAsync({ kind: "not-found", entity: "credential" }))

    const result = await testCredential("missing")

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("Credential not found")
    expect(verifyCredentialMock).not.toHaveBeenCalled()
  })

  it("returns a clean {ok:false} when the credential store errors (store failure is NOT null-graceful here — a clean error string)", async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(errAsync({ kind: "keyring-unavailable" }))

    const result = await testCredential("cred-1")

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("Failed to read the stored secret")
    expect(verifyCredentialMock).not.toHaveBeenCalled()
  })

  it("never returns secretRef or the plaintext secret in its result shape (metadata-only guard)", async () => {
    credentialsGetMock.mockReturnValue(okAsync(fakeCredentialRow))
    getMock.mockReturnValue(okAsync(fakePlatform))
    storeGetMock.mockReturnValue(okAsync("super-secret-value"))
    verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
    setVerifyStateMock.mockReturnValue(okAsync(undefined))

    const result = await testCredential("cred-1")
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain("super-secret-value")
    expect(serialized).not.toContain("ref-1") // secretRef
    expect(serialized).not.toContain("secretRef")
  })
})
