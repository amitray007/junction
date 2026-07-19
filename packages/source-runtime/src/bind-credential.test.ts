// SPDX-License-Identifier: AGPL-3.0-only
// bind-credential tests — verifyThenBind / confirmThenBind against a REAL
// (temp-home) DB + repos, with an in-memory CredentialStore stub (mirrors
// connect-from-catalog.test.ts's pattern) and verifyCredential MOCKED (this
// package's own module) so verify gating is exercised without a real network
// round-trip.
//
// Coverage (method file 43 §A3):
//   - auth-failed / unreachable -> NO write (credential stays unlinked).
//   - ok -> committed (platformId set) + setVerifyState persisted.
//   - not-verifiable (via confirmThenBind) -> committed WITHOUT ever calling
//     verifyCredential.

import {
  type CredentialStore,
  ok as coreOk,
  createCredentialStore,
  createRepositories,
  getDatabase,
  getPaths,
  type Platform,
  ResultAsync,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { confirmThenBind, verifyThenBind } from "./bind-credential.js"
import { verifyCredential } from "./verify-credential.js"

vi.mock("./verify-credential.js", () => ({
  verifyCredential: vi.fn(),
}))

// resolveSecret in bind-credential.ts reads the REAL createCredentialStore —
// mock it to return our in-memory stub so the seeded secret is actually the
// one resolveSecret reads (otherwise the stub is never consulted and the real
// temp-home store returns null for every ref). This makes the store stub
// load-bearing, which the verify-gating tests below rely on.
vi.mock("@junction/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/core")>()
  return { ...actual, createCredentialStore: vi.fn() }
})

afterEach(() => {
  vi.mocked(verifyCredential).mockReset()
})

// Build an in-memory store AND wire it as what the mocked createCredentialStore
// returns — so resolveSecret (which calls createCredentialStore) reads exactly
// the secrets this stub is seeded with.
function stubStore(): CredentialStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  const store: CredentialStore & { map: Map<string, string> } = {
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
  vi.mocked(createCredentialStore).mockReturnValue(new ResultAsync(Promise.resolve(coreOk(store))))
  return store
}

function cliPlatform(id: string): Platform {
  return {
    id: id as never,
    kind: "cli" as const,
    displayName: "Test CLI Platform",
    cli: {
      tools: [
        {
          name: "run",
          argv: [{ kind: "literal", value: "/bin/true" }],
          policy: { cwd: "/tmp", readPaths: [], writePaths: [], allowNet: [], timeoutMs: 1000 },
        },
      ],
    },
  }
}

describe("verifyThenBind", () => {
  it("verify ok -> credential is bound (platformId set) + setVerifyState persisted", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const platformId = "github"
      await repos.platforms.create(cliPlatform(platformId))

      const seeded = await repos.credentials.create({
        id: "cred-verify-ok",
        name: "standalone-verify-ok",
        platformId: null,
        kind: "env",
        secretRef: "ref-verify-ok",
      })
      if (seeded.isErr()) throw new Error("test setup: credential create failed")
      await store.set("ref-verify-ok", "sentinel-secret-do-not-leak")

      vi.mocked(verifyCredential).mockReturnValue(
        new ResultAsync(Promise.resolve(coreOk({ status: "ok" as const }))),
      )

      const result = await verifyThenBind({
        credentialId: "cred-verify-ok",
        platformId,
        paths,
        repos,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toMatchObject({ verified: true })
      }

      const reread = await repos.credentials.get("cred-verify-ok")
      expect(reread.isOk()).toBe(true)
      if (reread.isOk()) {
        expect(reread.value.platformId).toBe(platformId)
        expect(reread.value.lastVerifyResult).toBe("ok")
      }

      // The plaintext secret never appears in the DB-visible credential row.
      if (reread.isOk()) {
        expect(JSON.stringify(reread.value)).not.toContain("sentinel-secret-do-not-leak")
      }
    })
  })

  it("verify auth-failed -> ZERO writes (credential stays unlinked, no setVerifyState)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const platformId = "github"
      await repos.platforms.create(cliPlatform(platformId))

      const seeded = await repos.credentials.create({
        id: "cred-auth-failed",
        name: "standalone-auth-failed",
        platformId: null,
        kind: "env",
        secretRef: "ref-auth-failed",
      })
      if (seeded.isErr()) throw new Error("test setup: credential create failed")
      await store.set("ref-auth-failed", "wrong-secret")

      vi.mocked(verifyCredential).mockReturnValue(
        new ResultAsync(Promise.resolve(coreOk({ status: "auth-failed" as const }))),
      )

      const result = await verifyThenBind({
        credentialId: "cred-auth-failed",
        platformId,
        paths,
        repos,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual({ verified: false, outcome: { status: "auth-failed" } })
      }

      const reread = await repos.credentials.get("cred-auth-failed")
      expect(reread.isOk()).toBe(true)
      if (reread.isOk()) {
        expect(reread.value.platformId).toBeNull()
        expect(reread.value.lastVerifyResult).toBeUndefined()
      }
    })
  })

  it("verify unreachable -> ZERO writes", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const platformId = "github"
      await repos.platforms.create(cliPlatform(platformId))

      const seeded = await repos.credentials.create({
        id: "cred-unreachable",
        name: "standalone-unreachable",
        platformId: null,
        kind: "env",
        secretRef: "ref-unreachable",
      })
      if (seeded.isErr()) throw new Error("test setup: credential create failed")
      await store.set("ref-unreachable", "some-secret")

      vi.mocked(verifyCredential).mockReturnValue(
        new ResultAsync(
          Promise.resolve(coreOk({ status: "unreachable" as const, detail: "ECONNREFUSED" })),
        ),
      )

      const result = await verifyThenBind({
        credentialId: "cred-unreachable",
        platformId,
        paths,
        repos,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual({
          verified: false,
          outcome: { status: "unreachable", detail: "ECONNREFUSED" },
        })
      }

      const reread = await repos.credentials.get("cred-unreachable")
      expect(reread.isOk()).toBe(true)
      if (reread.isOk()) expect(reread.value.platformId).toBeNull()
    })
  })

  it("refuses to bind (ZERO writes, never verifies) when the secretRef resolves to NO stored secret", async () => {
    // credential-security review (inc 43): a credential whose secretRef resolves
    // to null must NOT proceed to verifyCredential — verifying with a null secret
    // builds an unauthenticated provider that could return {status:"ok"} against
    // an auth-optional endpoint and commit a FALSE-verified bind. resolveSecret
    // refuses null as a typed secret-unresolvable error BEFORE verify runs.
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      stubStore() // wired but seeded with NOTHING → get(ref) returns null

      const platformId = "github"
      await repos.platforms.create(cliPlatform(platformId))

      const seeded = await repos.credentials.create({
        id: "cred-no-secret",
        name: "standalone-no-secret",
        platformId: null,
        kind: "env",
        secretRef: "ref-that-resolves-to-nothing",
      })
      if (seeded.isErr()) throw new Error("test setup: credential create failed")

      // verifyCredential must NEVER be reached — assert it via a mock that would
      // fail the test if called.
      vi.mocked(verifyCredential).mockImplementation(() => {
        throw new Error("verifyCredential must not be called for a null-resolving secret")
      })

      const result = await verifyThenBind({
        credentialId: "cred-no-secret",
        platformId,
        paths,
        repos,
      })

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toMatchObject({ kind: "secret-unresolvable" })
      }

      // ZERO writes: platformId stays null, no verify-state persisted.
      const reread = await repos.credentials.get("cred-no-secret")
      expect(reread.isOk()).toBe(true)
      if (reread.isOk()) {
        expect(reread.value.platformId).toBeNull()
        expect(reread.value.lastVerifyResult).toBeUndefined()
      }
    })
  })
})

describe("confirmThenBind", () => {
  it("binds WITHOUT ever calling verifyCredential (not-verifiable / confirm-gated path)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)

      const platformId = "github-http"
      await repos.platforms.create(cliPlatform(platformId))

      const seeded = await repos.credentials.create({
        id: "cred-confirm",
        name: "standalone-confirm",
        platformId: null,
        kind: "env",
        secretRef: "ref-confirm",
      })
      if (seeded.isErr()) throw new Error("test setup: credential create failed")

      const result = await confirmThenBind({
        credentialId: "cred-confirm",
        platformId,
        repos,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toMatchObject({ unverified: true })
      }
      expect(verifyCredential).not.toHaveBeenCalled()

      const reread = await repos.credentials.get("cred-confirm")
      expect(reread.isOk()).toBe(true)
      if (reread.isOk()) expect(reread.value.platformId).toBe(platformId)

      // confirmThenBind never verifies -> no lastVerifyResult written.
      if (reread.isOk()) expect(reread.value.lastVerifyResult).toBeUndefined()

      const forPlatform = await repos.credentials.forPlatform(platformId as never)
      if (forPlatform.isOk()) expect(forPlatform.value).toHaveLength(1)
    })
  })

  it("increment 46 (RC): confirmThenBind no longer refuses on a same-account-label collision — binding never touches `name`, so a 2nd distinctly-named credential binds freely", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)

      const platformId = "github-http-2"
      await repos.platforms.create(cliPlatform(platformId))

      const seededA = await repos.credentials.create({
        id: "cred-dup-a",
        name: "standalone-dup-a",
        platformId,
        kind: "env",
        secretRef: "ref-dup-a",
      })
      if (seededA.isErr()) throw new Error("test setup: credential A create failed")

      const seededB = await repos.credentials.create({
        id: "cred-dup-b",
        name: "standalone-dup-b",
        platformId: null,
        kind: "env",
        secretRef: "ref-dup-b",
      })
      if (seededB.isErr()) throw new Error("test setup: credential B create failed")

      const result = await confirmThenBind({
        credentialId: "cred-dup-b",
        platformId,
        repos,
      })

      expect(result.isOk()).toBe(true)
      expect(verifyCredential).not.toHaveBeenCalled()

      const reread = await repos.credentials.get("cred-dup-b")
      if (reread.isOk()) expect(reread.value.platformId).toBe(platformId)

      const forPlatform = await repos.credentials.forPlatform(platformId as never)
      if (forPlatform.isOk()) expect(forPlatform.value).toHaveLength(2)
    })
  })
})
