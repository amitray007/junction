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

vi.mock("@junction/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/core")>()
  return {
    ...actual,
    getPaths: vi.fn(() => ({ home: "/fake" }) as ReturnType<typeof actual.getPaths>),
    createCredentialStore: vi.fn(
      () => okAsync({}) as ReturnType<typeof actual.createCredentialStore>,
    ),
    createRepositories: vi.fn(
      () =>
        ({
          platforms: { get: getMock },
        }) as unknown as ReturnType<typeof actual.createRepositories>,
    ),
  }
})

vi.mock("./shared.server.js", () => ({
  getDb: vi.fn(async () => ({})),
}))

const { mutateAddCredential } = await import("./mutations.server.js")

afterEach(() => {
  getMock.mockReset()
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
