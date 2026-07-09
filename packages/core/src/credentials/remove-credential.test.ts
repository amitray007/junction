// SPDX-License-Identifier: AGPL-3.0-only
// removeCredential tests — increment 32.7 item 1: warn-on-orphan.
//
// SECURITY coverage:
//   (a) store.delete failure → removeCredential still resolves ok (best-effort,
//       DB row is authoritative), spy logger's warn is called exactly once with
//       credentialId + secretRef in meta, and the secret VALUE never appears in
//       any logged call args (only the handle secretRef and the error KIND).
//   (b) store.delete success → no warn call at all.

import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { afterEach, describe, expect, it } from "vitest"
import type { CredentialError, DbError } from "../errors/index.js"
import { type Logger, noopLogger, setLogger } from "../logging/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { Credential } from "../schema/credential.js"
import { removeCredential } from "./remove-credential.js"
import type { CredentialStore } from "./store.js"

const SECRET_VALUE_SENTINEL = "SENTINEL_SECRET_VALUE_MUST_NOT_LEAK"

function makeCredential(): Credential {
  return {
    id: "cred-1",
    platformId: "plat-1",
    profileName: "work",
    kind: "bearer",
    secretRef: "secret-ref-abc123",
  }
}

/** A repo stub whose get() returns a fixed credential and delete() always succeeds. */
function makeRepo(credential: Credential): CredentialsRepo {
  return {
    get: () => okAsync(credential),
    delete: () => okAsync(undefined),
  } as unknown as CredentialsRepo
}

function makeStore(deleteResult: ResultAsync<void, CredentialError>): CredentialStore {
  return {
    backend: "encrypted-file",
    get: () => okAsync(null),
    set: () => okAsync(undefined),
    delete: () => deleteResult,
  }
}

/** A spy Logger that records every call's (level, msg, meta) tuple. */
function makeSpyLogger(): {
  logger: Logger
  calls: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>
} {
  const calls: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = []
  const logger: Logger = {
    debug: (msg, meta) => calls.push({ level: "debug", msg, meta }),
    info: (msg, meta) => calls.push({ level: "info", msg, meta }),
    warn: (msg, meta) => calls.push({ level: "warn", msg, meta }),
    error: (msg, meta) => calls.push({ level: "error", msg, meta }),
  }
  return { logger, calls }
}

describe("removeCredential — warn-on-orphan (increment 32.7 item 1)", () => {
  afterEach(() => {
    // The logger is a module-global — always restore to avoid leaking a spy
    // into unrelated tests that run in the same worker.
    setLogger(noopLogger)
  })

  it("(a) store.delete fails -> removeCredential still returns ok, warn called once with credentialId + secretRef, no secret value leaked", async () => {
    const credential = makeCredential()
    const repo = makeRepo(credential)
    const store = makeStore(
      errAsync({ kind: "io-failed", cause: SECRET_VALUE_SENTINEL } as CredentialError),
    )
    const { logger, calls } = makeSpyLogger()
    setLogger(logger)

    const result = await removeCredential(credential.id, store, repo)

    expect(result.isOk()).toBe(true)

    const warnCalls = calls.filter((c) => c.level === "warn")
    expect(warnCalls).toHaveLength(1)
    expect(warnCalls[0]?.meta?.credentialId).toBe(credential.id)
    expect(warnCalls[0]?.meta?.secretRef).toBe(credential.secretRef)

    // THE LOAD-BEARING ASSERTION: the secret VALUE never appears in any logged call.
    const serialised = JSON.stringify(calls)
    expect(serialised).not.toContain(SECRET_VALUE_SENTINEL)
  })

  it("(b) store.delete succeeds -> no warn call", async () => {
    const credential = makeCredential()
    const repo = makeRepo(credential)
    const store = makeStore(okAsync(undefined))
    const { logger, calls } = makeSpyLogger()
    setLogger(logger)

    const result = await removeCredential(credential.id, store, repo)

    expect(result.isOk()).toBe(true)
    expect(calls.filter((c) => c.level === "warn")).toHaveLength(0)
  })

  it("in-use DB error short-circuits before any store interaction (existing behaviour, unaffected)", async () => {
    const credential = makeCredential()
    const repo = {
      get: () => okAsync(credential),
      delete: () => errAsync({ kind: "in-use", cause: "fk" } as DbError),
    } as unknown as CredentialsRepo
    const store = makeStore(okAsync(undefined))
    const { logger, calls } = makeSpyLogger()
    setLogger(logger)

    const result = await removeCredential(credential.id, store, repo)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("in-use")
    expect(calls).toHaveLength(0)
  })
})
