// SPDX-License-Identifier: AGPL-3.0-only
// addCredential tests — increment 28.9 slice D: the 32 KiB file-content cap.
//
// SECURITY coverage:
//   (a) file content > 32 KiB → rejected BEFORE any store write (mock store
//       asserts .set() is never called).
//   (b) file content exactly at the 32 KiB boundary → accepted.
//   (c) non-file kinds are NOT subject to the cap (a bearer/api-key/env secret
//       larger than 32 KiB is unaffected — the cap is file-content-specific).
//   (d) the oversized content itself never appears in the returned error.

import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { describe, expect, it } from "vitest"
import type { DbError } from "../errors/index.js"
import { newCredentialId, newPlatformId } from "../ids/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { Credential } from "../schema/credential.js"
import type { Platform } from "../schema/platform.js"
import { addCredential, FILE_SECRET_MAX_BYTES } from "./add-credential.js"
import type { CredentialStore } from "./store.js"

// ---------------------------------------------------------------------------
// Fixtures — a cli platform (the only kind accepting "file") + mock store/repo
// ---------------------------------------------------------------------------

function cliPlatform(): Platform {
  return {
    id: newPlatformId(),
    kind: "cli" as const,
    displayName: "Test CLI Platform",
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
      credentialEnvVar: "GH_PAT",
    },
  }
}

/** A store whose .set() records calls so tests can assert it was NEVER invoked. */
function makeSpyStore(): {
  store: CredentialStore
  setCalls: Array<{ ref: string; secret: string }>
} {
  const setCalls: Array<{ ref: string; secret: string }> = []
  const store: CredentialStore = {
    backend: "encrypted-file",
    get: () => okAsync(null),
    set: (ref: string, secret: string) => {
      setCalls.push({ ref, secret })
      return okAsync(undefined)
    },
    delete: () => okAsync(undefined),
  }
  return { store, setCalls }
}

/** A minimal CredentialsRepo stub — create() always succeeds (unused when the cap rejects first). */
function makeStubRepo(): CredentialsRepo {
  return {
    create: (input: Credential): ResultAsync<Credential, DbError> => okAsync(input),
    get: () => errAsync({ kind: "not-found", entity: "credential", id: "unused" } as DbError),
    forPlatform: () => okAsync([]),
    list: () => okAsync([]),
    setSecretRef: (): ResultAsync<Credential, DbError> =>
      errAsync({ kind: "not-found", entity: "credential", id: "unused" } as DbError),
    delete: () => okAsync(undefined),
    setVerifyState: () => okAsync(undefined),
  } as unknown as CredentialsRepo
}

/**
 * A CredentialsRepo stub whose `forPlatform` reports NO existing credentials
 * (so the app-level 30.12 guard lets the call through), but whose `create`
 * always fails with a "constraint-violation" DbError — simulating a
 * duplicate that slipped past the guard and hit the DB-level unique index
 * from migration 0010 (increment 32.9).
 */
function makeConstraintViolatingRepo(): CredentialsRepo {
  return {
    create: (): ResultAsync<Credential, DbError> =>
      errAsync({ kind: "constraint-violation", cause: new Error("UNIQUE constraint failed") }),
    get: () => errAsync({ kind: "not-found", entity: "credential", id: "unused" } as DbError),
    forPlatform: () => okAsync([]),
    list: () => okAsync([]),
    setSecretRef: (): ResultAsync<Credential, DbError> =>
      errAsync({ kind: "not-found", entity: "credential", id: "unused" } as DbError),
    delete: () => okAsync(undefined),
    setVerifyState: () => okAsync(undefined),
  } as unknown as CredentialsRepo
}

/** A store whose .set() and .delete() both record calls, so tests can assert cleanup ran. */
function makeCleanupSpyStore(): {
  store: CredentialStore
  setCalls: Array<{ ref: string; secret: string }>
  deleteCalls: string[]
} {
  const setCalls: Array<{ ref: string; secret: string }> = []
  const deleteCalls: string[] = []
  const store: CredentialStore = {
    backend: "encrypted-file",
    get: () => okAsync(null),
    set: (ref: string, secret: string) => {
      setCalls.push({ ref, secret })
      return okAsync(undefined)
    },
    delete: (ref: string) => {
      deleteCalls.push(ref)
      return okAsync(undefined)
    },
  }
  return { store, setCalls, deleteCalls }
}

/**
 * A CredentialsRepo stub whose `forPlatform` returns a fixed set of existing
 * credentials, and whose `create` records every call in `createCalls` so
 * tests can assert nothing was written on a duplicate-account rejection.
 */
function makeRecordingRepo(existing: Credential[]): {
  repo: CredentialsRepo
  createCalls: Credential[]
} {
  const createCalls: Credential[] = []
  const repo = {
    create: (input: Credential): ResultAsync<Credential, DbError> => {
      createCalls.push(input)
      return okAsync(input)
    },
    get: () => errAsync({ kind: "not-found", entity: "credential", id: "unused" } as DbError),
    forPlatform: () => okAsync(existing),
    list: () => okAsync(existing),
    setSecretRef: (): ResultAsync<Credential, DbError> =>
      errAsync({ kind: "not-found", entity: "credential", id: "unused" } as DbError),
    delete: () => okAsync(undefined),
    setVerifyState: () => okAsync(undefined),
  } as unknown as CredentialsRepo
  return { repo, createCalls }
}

describe("addCredential — 32 KiB file-content cap (increment 28.9 slice D)", () => {
  it("(a) file content > 32 KiB is rejected with invalid-input BEFORE any store write", async () => {
    const platform = cliPlatform()
    const { store, setCalls } = makeSpyStore()
    const repo = makeStubRepo()

    const oversized = "x".repeat(FILE_SECRET_MAX_BYTES + 1)
    const result = await addCredential(
      { platformId: String(platform.id), account: "work", kind: "file", secret: oversized },
      platform,
      store,
      repo,
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("invalid-input")
      if (result.error.kind === "invalid-input") {
        expect(result.error.reason).toContain("32 KiB")
      }
    }

    // THE LOAD-BEARING ASSERTION: the store must never have been touched.
    expect(setCalls).toHaveLength(0)
  })

  it("(b) file content exactly at the 32 KiB boundary is accepted", async () => {
    const platform = cliPlatform()
    const { store, setCalls } = makeSpyStore()
    const repo = makeStubRepo()

    const atLimit = "x".repeat(FILE_SECRET_MAX_BYTES)
    const result = await addCredential(
      { platformId: String(platform.id), account: "work", kind: "file", secret: atLimit },
      platform,
      store,
      repo,
    )

    expect(result.isOk()).toBe(true)
    expect(setCalls).toHaveLength(1)
  })

  it("(c) multi-byte UTF-8 content is measured in BYTES, not characters (a string under the char count but over the byte cap is rejected)", async () => {
    const platform = cliPlatform()
    const { store, setCalls } = makeSpyStore()
    const repo = makeStubRepo()

    // Each "€" is 3 bytes in UTF-8. FILE_SECRET_MAX_BYTES/2 + 1 chars of "€"
    // exceeds the byte cap while having far fewer JS string code units than
    // the byte limit — proves the check uses Buffer.byteLength, not .length.
    const charCount = Math.floor(FILE_SECRET_MAX_BYTES / 2) + 1
    const multiByte = "€".repeat(charCount)
    expect(multiByte.length).toBeLessThan(FILE_SECRET_MAX_BYTES) // char count is under the cap
    expect(Buffer.byteLength(multiByte, "utf8")).toBeGreaterThan(FILE_SECRET_MAX_BYTES) // but bytes are over

    const result = await addCredential(
      { platformId: String(platform.id), account: "work", kind: "file", secret: multiByte },
      platform,
      store,
      repo,
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("invalid-input")
    expect(setCalls).toHaveLength(0)
  })

  it("(d) the oversized content never appears in the returned error", async () => {
    const platform = cliPlatform()
    const { store } = makeSpyStore()
    const repo = makeStubRepo()

    const SENTINEL_PREFIX = "SENTINEL_MUST_NOT_LEAK_"
    const oversized = SENTINEL_PREFIX + "y".repeat(FILE_SECRET_MAX_BYTES)
    const result = await addCredential(
      { platformId: String(platform.id), account: "work", kind: "file", secret: oversized },
      platform,
      store,
      repo,
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      const serialised = JSON.stringify(result.error)
      expect(serialised).not.toContain(SENTINEL_PREFIX)
    }
  })

  it("(e) non-file kinds are NOT subject to the 32 KiB cap", async () => {
    // A cli platform also accepts "env" and legacy "bearer" — neither is capped.
    const platform = cliPlatform()
    const { store, setCalls } = makeSpyStore()
    const repo = makeStubRepo()

    const huge = "z".repeat(FILE_SECRET_MAX_BYTES * 2)
    const result = await addCredential(
      { platformId: String(platform.id), account: "work", kind: "env", secret: huge },
      platform,
      store,
      repo,
    )

    expect(result.isOk()).toBe(true)
    expect(setCalls).toHaveLength(1)
  })
})

describe("addCredential — name derivation from the account seed (increment 46)", () => {
  it("two credentials on the same platform with different account seeds -> both succeed, distinct derived names", async () => {
    const platform = cliPlatform()
    // deriveCredentialName slugifies (lowercases) platformId — the fixture's
    // ULID platform.id is uppercase, so the derived name is lowercase.
    const platformIdLower = String(platform.id).toLowerCase()
    const { store, setCalls } = makeSpyStore()
    const { repo, createCalls } = makeRecordingRepo([
      {
        id: newCredentialId(),
        name: `${platformIdLower}-work`,
        platformId: String(platform.id),
        kind: "bearer",
        secretRef: "existing-ref",
      },
    ])

    const result = await addCredential(
      { platformId: String(platform.id), account: "personal", kind: "bearer", secret: "tok" },
      platform,
      store,
      repo,
    )

    expect(result.isOk()).toBe(true)
    expect(setCalls).toHaveLength(1)
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.name).toBe(`${platformIdLower}-personal`)
  })

  it("no existing credentials on the platform -> succeeds (first account)", async () => {
    const platform = cliPlatform()
    const { store, setCalls } = makeSpyStore()
    const { repo, createCalls } = makeRecordingRepo([])

    const result = await addCredential(
      { platformId: String(platform.id), account: "default", kind: "bearer", secret: "tok" },
      platform,
      store,
      repo,
    )

    expect(result.isOk()).toBe(true)
    expect(setCalls).toHaveLength(1)
    expect(createCalls).toHaveLength(1)
  })

  it("a SAME account seed on the same platform now succeeds too — the old duplicate-account app-level guard is GONE (RC); derivation just suffixes -2", async () => {
    const platform = cliPlatform()
    const platformIdLower = String(platform.id).toLowerCase()
    const { store, setCalls } = makeSpyStore()
    const { repo, createCalls } = makeRecordingRepo([
      {
        id: newCredentialId(),
        name: `${platformIdLower}-work`,
        platformId: String(platform.id),
        kind: "bearer",
        secretRef: "existing-ref",
      },
    ])

    const result = await addCredential(
      { platformId: String(platform.id), account: "work", kind: "bearer", secret: "tok" },
      platform,
      store,
      repo,
    )

    expect(result.isOk()).toBe(true)
    expect(setCalls).toHaveLength(1)
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.name).toBe(`${platformIdLower}-work-2`)
  })
})

describe("addCredential — DB-level unique-name backstop (increment 46, RC)", () => {
  it("a constraint-violation from repo.create() surfaces as typed duplicate-name, AND the just-set store secret is cleaned up", async () => {
    const platform = cliPlatform()
    const platformIdLower = String(platform.id).toLowerCase()
    const { store, setCalls, deleteCalls } = makeCleanupSpyStore()
    const repo = makeConstraintViolatingRepo()

    const result = await addCredential(
      { platformId: String(platform.id), account: "work", kind: "bearer", secret: "tok" },
      platform,
      store,
      repo,
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("duplicate-name")
      if (result.error.kind === "duplicate-name") {
        expect(result.error.name).toBe(`${platformIdLower}-work`)
      }
    }

    // The secret WAS written to the store (name derivation didn't catch it —
    // only the DB index did), and cleanup must have deleted it: no stranded
    // fresh secret.
    expect(setCalls).toHaveLength(1)
    expect(deleteCalls).toEqual([setCalls[0]?.ref])
  })
})
