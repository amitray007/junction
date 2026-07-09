// SPDX-License-Identifier: AGPL-3.0-only
// EncryptedFileStore — AES-256-GCM credential store backed by ~/.junction/credentials.enc.json.
// SECURITY: fresh IV per set(), auth-tag verified before final(), AAD = secretRef.
// NEVER logs the key, plaintext, or the full encrypted map. NEVER puts secret values in error cause.

import { randomBytes } from "node:crypto"
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { err, ok, okAsync, ResultAsync } from "neverthrow"
import type { CredentialError } from "../errors/index.js"
import type { JunctionPaths } from "../paths/index.js"
import type { CredentialStore } from "./store.js"
import { type EncFile, EncFileSchema, gcmDecrypt, gcmEncrypt } from "./vault-crypto.js"

// ---- helpers ----

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

/**
 * Load and parse the on-disk credentials file.
 *
 * ENOENT (file genuinely absent) → return empty map (normal first-run path).
 * Any other error (SyntaxError, Zod parse failure, I/O error on a PRESENT file) → throw,
 * so the caller maps it to io-failed Err.
 *
 * FIX 2: previously a SyntaxError on a PRESENT file was silently treated as empty, which
 * caused the next set() to atomically OVERWRITE the corrupt-but-present file, permanently
 * destroying all previously-stored ciphertext. Now only ENOENT is swallowed; a corrupt-
 * but-present file propagates the error so callers return io-failed and refuse to overwrite.
 */
async function loadEncFile(credentialsFile: string): Promise<EncFile> {
  try {
    const raw = await readFile(credentialsFile, "utf-8")
    return EncFileSchema.parse(JSON.parse(raw) as unknown)
  } catch (e: unknown) {
    if (isNodeError(e) && e.code === "ENOENT") return { v: 1, entries: {} }
    // SyntaxError, ZodError, or any other I/O error on a PRESENT file → rethrow.
    // The caller (loadOrIoFailed) maps this to io-failed Err, which blocks set() from
    // overwriting a corrupt-but-present credentials file.
    throw e
  }
}

async function saveEncFile(paths: JunctionPaths, data: EncFile): Promise<void> {
  const { lock } = await import("proper-lockfile")
  const lockfilePath = path.join(paths.home, ".credentials.lock")
  const tmp = path.join(paths.home, `.credentials.${randomBytes(8).toString("hex")}.tmp`)
  let release: (() => Promise<void>) | undefined
  try {
    release = await lock(paths.home, { lockfilePath })
    // FIX 1: create the tmp file at 0600 immediately so the ciphertext is never briefly
    // world-readable between writeFile and chmod (lower-stakes than master-key, but same
    // pattern — belt-and-suspenders with the post-write chmod below).
    await writeFile(tmp, JSON.stringify(data), { encoding: "utf-8", mode: 0o600 })
    // Belt-and-suspenders: chmod again after write (handles cross-device rename edge cases).
    await chmod(tmp, 0o600)
    await rename(tmp, paths.credentialsFile)
  } finally {
    await unlink(tmp).catch(() => {})
    if (release) await release().catch(() => {})
  }
}

// ---- store ----

/** Load the enc-file, mapping any filesystem/parse failure to an io-failed Err. */
function loadOrIoFailed(credentialsFile: string): ResultAsync<EncFile, CredentialError> {
  return ResultAsync.fromPromise(
    loadEncFile(credentialsFile),
    (cause): CredentialError => ({ kind: "io-failed", cause }),
  )
}

/** Persist the enc-file, mapping any write failure to an io-failed Err. */
function saveOrIoFailed(paths: JunctionPaths, data: EncFile): ResultAsync<void, CredentialError> {
  return ResultAsync.fromPromise(
    saveEncFile(paths, data),
    (cause): CredentialError => ({ kind: "io-failed", cause }),
  )
}

export function createEncryptedFileStore(paths: JunctionPaths, key: Buffer): CredentialStore {
  return {
    backend: "encrypted-file",

    get(secretRef: string): ResultAsync<string | null, CredentialError> {
      return loadOrIoFailed(paths.credentialsFile).andThen((data) => {
        const record = data.entries[secretRef]
        if (record === undefined) return ok<string | null, CredentialError>(null)
        try {
          return ok<string | null, CredentialError>(gcmDecrypt(key, Buffer.from(secretRef), record))
        } catch (cause) {
          // SECURITY: never return partial plaintext; the GCM auth failure carries no secret data
          return err<string | null, CredentialError>({ kind: "decrypt-failed", cause })
        }
      })
    },

    set(secretRef: string, secret: string): ResultAsync<void, CredentialError> {
      return loadOrIoFailed(paths.credentialsFile).andThen((data) => {
        data.entries[secretRef] = gcmEncrypt(key, Buffer.from(secretRef), secret)
        return saveOrIoFailed(paths, data)
      })
    },

    delete(secretRef: string): ResultAsync<void, CredentialError> {
      return loadOrIoFailed(paths.credentialsFile).andThen((data) => {
        if (!(secretRef in data.entries)) return okAsync<void, CredentialError>(undefined)
        const { [secretRef]: _removed, ...rest } = data.entries
        return saveOrIoFailed(paths, { v: 1, entries: rest })
      })
    },
  }
}
