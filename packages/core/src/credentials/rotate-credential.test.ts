// SPDX-License-Identifier: AGPL-3.0-only
// rotateCredential tests.
//
// SECURITY coverage:
//   (a) happy path — secret changes in store; id/account/platform stable; old
//       secretRef no longer resolves; new one does.
//   (b) NEGATIVE: newSecret never appears in the return value or any error
//       (JSON.stringify sentinel check).
//   (c) DB-update failure after store write → old secret still resolves; new
//       store entry cleaned up (injected failing repo stub).
//   (d) unknown credentialId → typed not-found error.
//
// Repo-level: setSecretRef method covered here and in repositories.test.ts.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errAsync, type ResultAsync } from "neverthrow"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Db } from "../db/index.js"
import { getDatabase } from "../db/index.js"
import type { DbError } from "../errors/index.js"
import { newPlatformId } from "../ids/index.js"
import { ensureHome, getPaths } from "../paths/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import { createRepositories } from "../repositories/index.js"
import type { Credential } from "../schema/credential.js"
import { addCredential } from "./add-credential.js"
import { createEncryptedFileStore } from "./encrypted-file-store.js"
import { resolveMasterKey } from "./master-key.js"
import { rotateCredential } from "./rotate-credential.js"
import type { CredentialStore } from "./store.js"

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

describe("rotateCredential", () => {
  let db: Db
  let repos: ReturnType<typeof createRepositories>
  let store: CredentialStore
  let home: string
  let prevHome: string | undefined
  let prevStore: string | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    home = await mkdtemp(join(tmpdir(), "junction-rotate-test-"))
    process.env.JUNCTION_HOME = home
    process.env.JUNCTION_STORE = "file"

    await ensureHome()
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) throw dbResult.error
    db = dbResult.value
    repos = createRepositories(db)

    const keyResult = await resolveMasterKey(paths, process.env)
    if (keyResult.isErr()) throw keyResult.error
    store = createEncryptedFileStore(paths, keyResult.value)

    // Seed a platform so credentials have a valid FK.
    await repos.platforms.create({
      id: newPlatformId(),
      kind: "mcp" as const,
      displayName: "Test Platform",
    })
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    await rm(home, { recursive: true, force: true })
  })

  // Helper: seed a credential and return its id + the old secret.
  async function seedCredential(
    platformId: string,
    account: string,
    secret: string,
  ): Promise<string> {
    const result = await addCredential(
      { platformId, account, kind: "bearer", secret },
      store,
      repos.credentials,
    )
    if (result.isErr()) throw result.error
    return String(result.value.id)
  }

  // Get the platformId we seeded (there's exactly one).
  async function getPlatformId(): Promise<string> {
    const list = await repos.platforms.list()
    if (list.isErr()) throw list.error
    const plat = list.value[0]
    if (!plat) throw new Error("No platform seeded")
    return String(plat.id)
  }

  // ---------------------------------------------------------------------------
  // (a) Happy path
  // ---------------------------------------------------------------------------

  it("(a) happy path: secret changes; id/account/platform are stable; old secretRef gone", async () => {
    const platformId = await getPlatformId()
    const OLD_SECRET = "old-secret-abc"
    const NEW_SECRET = "new-secret-xyz"
    const credId = await seedCredential(platformId, "work", OLD_SECRET)

    // Capture old secretRef before rotation.
    const beforeRow = await repos.credentials.get(credId)
    expect(beforeRow.isOk()).toBe(true)
    if (!beforeRow.isOk()) return
    const oldSecretRef = beforeRow.value.secretRef

    const result = await rotateCredential(
      { credentialId: credId, newSecret: NEW_SECRET },
      store,
      repos.credentials,
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const cred = result.value

    // Identity fields must not change.
    expect(String(cred.id)).toBe(credId)
    expect(String(cred.platformId)).toBe(platformId)
    expect(cred.profileName).toBe("work")
    expect(cred.kind).toBe("bearer")

    // New secretRef must differ from the old one.
    expect(cred.secretRef).not.toBe(oldSecretRef)

    // Old secretRef must no longer resolve in the store.
    const oldGet = await store.get(oldSecretRef)
    expect(oldGet.isOk()).toBe(true)
    if (oldGet.isOk()) expect(oldGet.value).toBeNull()

    // New secretRef must resolve to the new secret.
    const newGet = await store.get(cred.secretRef)
    expect(newGet.isOk()).toBe(true)
    if (newGet.isOk()) expect(newGet.value).toBe(NEW_SECRET)
  })

  // ---------------------------------------------------------------------------
  // (b) Negative: newSecret never in return value or error
  // ---------------------------------------------------------------------------

  it("(b) NEGATIVE: newSecret sentinel never appears in JSON-serialised return or error", async () => {
    const platformId = await getPlatformId()
    const SENTINEL = "ROTATE_SENTINEL_MUST_NEVER_APPEAR_IN_OUTPUT_xyz987"
    const credId = await seedCredential(platformId, "work", "old-secret")

    const result = await rotateCredential(
      { credentialId: credId, newSecret: SENTINEL },
      store,
      repos.credentials,
    )

    // The result must be Ok (rotation succeeded).
    expect(result.isOk()).toBe(true)

    // Serialise the entire result shape and assert the sentinel is absent.
    const serialised = JSON.stringify(result.isOk() ? result.value : result)
    expect(serialised, "sentinel appeared in return value").not.toContain(SENTINEL)

    // Also verify it doesn't appear in the Credential's string fields.
    if (result.isOk()) {
      expect(String(result.value.id)).not.toContain(SENTINEL)
      expect(String(result.value.platformId)).not.toContain(SENTINEL)
      expect(result.value.profileName).not.toContain(SENTINEL)
      expect(result.value.secretRef).not.toContain(SENTINEL)
    }
  })

  it("(b) NEGATIVE: newSecret sentinel never appears in error when rotation fails", async () => {
    const SENTINEL = "ROTATE_ERR_SENTINEL_xyz654"

    // Use an unknown credentialId → not-found error — secret still mustn't leak.
    const result = await rotateCredential(
      { credentialId: "cred_nonexistent_id", newSecret: SENTINEL },
      store,
      repos.credentials,
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      const serialised = JSON.stringify(result.error)
      expect(serialised, "sentinel appeared in error").not.toContain(SENTINEL)
    }
  })

  // ---------------------------------------------------------------------------
  // (c) DB-update failure after store write: old secret intact; new entry cleaned
  // ---------------------------------------------------------------------------

  it("(c) DB-update failure: old secret still resolves; new store entry cleaned up", async () => {
    const platformId = await getPlatformId()
    const OLD_SECRET = "old-secret-rollback"
    const credId = await seedCredential(platformId, "work", OLD_SECRET)

    // Capture old secretRef.
    const beforeRow = await repos.credentials.get(credId)
    expect(beforeRow.isOk()).toBe(true)
    if (!beforeRow.isOk()) return
    const oldSecretRef = beforeRow.value.secretRef

    // Build a failing repo stub: delegates everything to the real repo EXCEPT
    // setSecretRef, which always returns a DB error.
    const newSecretRefsWritten: string[] = []
    const failingRepo: CredentialsRepo = {
      ...repos.credentials,
      setSecretRef(_id: string, newRef: string): ResultAsync<Credential, DbError> {
        // Record what was attempted so we can assert cleanup below.
        newSecretRefsWritten.push(newRef)
        return errAsync<Credential, DbError>({
          kind: "query-failed" as const,
          cause: new Error("stubbed DB failure"),
        })
      },
    }

    const result = await rotateCredential(
      { credentialId: credId, newSecret: "new-secret-should-rollback" },
      store,
      failingRepo,
    )

    // Must return an Err (the DB error propagated).
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("query-failed")
    }

    // Old secretRef must still resolve to the old secret (credential still works).
    const oldGet = await store.get(oldSecretRef)
    expect(oldGet.isOk()).toBe(true)
    if (oldGet.isOk()) expect(oldGet.value).toBe(OLD_SECRET)

    // The new secretRef that was written should have been cleaned up.
    expect(newSecretRefsWritten.length).toBe(1)
    const newRef = newSecretRefsWritten[0]
    if (!newRef) throw new Error("Expected a new secretRef to have been written")
    const newGet = await store.get(newRef)
    expect(newGet.isOk()).toBe(true)
    if (newGet.isOk()) expect(newGet.value).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // (d) Unknown credentialId → typed not-found error
  // ---------------------------------------------------------------------------

  it("(d) unknown credentialId → typed not-found DbError", async () => {
    const result = await rotateCredential(
      { credentialId: "cred_does_not_exist", newSecret: "irrelevant" },
      store,
      repos.credentials,
    )
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("not-found")
    }
  })

  // ---------------------------------------------------------------------------
  // (e) Rollback cleanup ALSO fails: DB error still propagates; cleanup failure
  //     is swallowed and does NOT mask the original error or leak the new secret.
  // ---------------------------------------------------------------------------

  it("(e) rollback-cleanup-also-fails: DB error propagates; cleanup failure swallowed; secret not leaked", async () => {
    const platformId = await getPlatformId()
    const OLD_SECRET = "old-secret-cleanup-fail"
    const NEW_SECRET = "new-secret-cleanup-fail-sentinel"
    const credId = await seedCredential(platformId, "work", OLD_SECRET)

    // Capture old secretRef before rotation.
    const beforeRow = await repos.credentials.get(credId)
    expect(beforeRow.isOk()).toBe(true)
    if (!beforeRow.isOk()) return
    const oldSecretRef = beforeRow.value.secretRef

    // Build a repo stub where setSecretRef always fails (DB error).
    const failingRepo: CredentialsRepo = {
      ...repos.credentials,
      setSecretRef(_id: string, _newRef: string): ResultAsync<Credential, DbError> {
        return errAsync<Credential, DbError>({
          kind: "query-failed" as const,
          cause: new Error("stubbed DB failure for cleanup test"),
        })
      },
    }

    // Build a store wrapper whose .delete always errors — simulating both the
    // rollback-cleanup delete (new ref) AND the happy-path old-ref delete failing.
    // For reads/writes (get/set) we delegate to the real store.
    const failingDeleteStore: CredentialStore = {
      ...store,
      delete: (_ref: string) =>
        errAsync({ kind: "io-failed" as const, cause: new Error("stub delete fail") }),
    }

    const result = await rotateCredential(
      { credentialId: credId, newSecret: NEW_SECRET },
      failingDeleteStore,
      failingRepo,
    )

    // Must return Err — the original DB error propagates despite cleanup also failing.
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      // The DB error kind must be preserved — cleanup failure must NOT replace it.
      expect(result.error.kind).toBe("query-failed")
      // The new secret must NOT appear in the serialised error.
      const serialised = JSON.stringify(result.error)
      expect(serialised, "new secret appeared in error").not.toContain(NEW_SECRET)
    }

    // Old secretRef must still resolve via the REAL store — credential still works.
    const oldGet = await store.get(oldSecretRef)
    expect(oldGet.isOk()).toBe(true)
    if (oldGet.isOk()) expect(oldGet.value).toBe(OLD_SECRET)
  })
})
