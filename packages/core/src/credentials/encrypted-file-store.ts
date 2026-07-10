// SPDX-License-Identifier: AGPL-3.0-only
// EncryptedFileStore — AES-256-GCM credential store backed by ~/.junction/credentials.enc.json.
// SECURITY: fresh IV per set(), auth-tag verified before final(), AAD = secretRef.
// NEVER logs the key, plaintext, or the full encrypted map. NEVER puts secret values in error cause.

import { randomBytes } from "node:crypto"
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { err, ok, ResultAsync } from "neverthrow"
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

/**
 * Write `data` to disk atomically. NEVER acquires the lock itself — every
 * caller (withCredentialsLock below, and rotate-master-key.ts's OWN direct
 * writeFile0600/rename sequence) is responsible for holding
 * `.credentials.lock` for the entire load→mutate→save critical section. This
 * function only performs the write half.
 */
async function writeEncFile(paths: JunctionPaths, data: EncFile): Promise<void> {
  const tmp = path.join(paths.home, `.credentials.${randomBytes(8).toString("hex")}.tmp`)
  try {
    // FIX 1: create the tmp file at 0600 immediately so the ciphertext is never briefly
    // world-readable between writeFile and chmod (lower-stakes than master-key, but same
    // pattern — belt-and-suspenders with the post-write chmod below).
    await writeFile(tmp, JSON.stringify(data), { encoding: "utf-8", mode: 0o600 })
    // Belt-and-suspenders: chmod again after write (handles cross-device rename edge cases).
    await chmod(tmp, 0o600)
    await rename(tmp, paths.credentialsFile)
  } finally {
    await unlink(tmp).catch(() => {})
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

/**
 * LOST-UPDATE FIX (32.13 Slice A, HIGH): acquire the home-dir lock ONCE, then
 * load → mutate → save entirely INSIDE the critical section, releasing in
 * `finally`. Mirrors tool-pins.ts's savePinFile / config's saveConfig
 * re-read-under-lock-and-merge pattern.
 *
 * Before this fix, `set`/`delete` each called loadOrIoFailed (unlocked) then
 * saveEncFile (which acquired the lock only around its OWN write). Two
 * concurrent writers each loaded the SAME pre-mutation map, then each saved
 * their own snapshot serially under the lock — the second writer's save
 * clobbered the first writer's ref with a snapshot that never saw it, so a
 * concurrent `credentials.create` could report success while its ciphertext
 * silently vanished from disk (an un-decryptable/missing credential).
 *
 * `mutate` receives the CURRENT on-disk map (re-read under the lock, not a
 * stale snapshot from before the lock was acquired) and returns the new map
 * to persist. Uses the SAME lockfile path (`.credentials.lock`) as
 * rotate-master-key.ts's `acquireLock` — mutually exclusive with an in-flight
 * rotation. Do NOT call this from rotate-master-key.ts: that path
 * deliberately bypasses this locked read-mutate-write (writes directly via
 * writeFile0600/rename under its OWN acquireLock) because its multi-step
 * sequence must hold the lock across steps this function doesn't know about
 * — see rotate-master-key.ts's file header.
 *
 * RETRIES: proper-lockfile's default is `retries: 0` — a second concurrent
 * `lock()` call fails immediately with ELOCKED instead of waiting for the
 * first to release. Two in-process `store.set()` calls firing concurrently
 * (the exact scenario this fix targets) would otherwise have one caller's
 * lock() reject outright. Retry with bounded exponential backoff (matches
 * this store's writes being fast, sub-10ms critical sections) so a
 * concurrent caller waits for the lock instead of failing.
 */
function withCredentialsLock(
  paths: JunctionPaths,
  mutate: (data: EncFile) => EncFile,
): ResultAsync<void, CredentialError> {
  return ResultAsync.fromPromise(
    (async () => {
      const { lock } = await import("proper-lockfile")
      const lockfilePath = path.join(paths.home, ".credentials.lock")
      const release = await lock(paths.home, {
        lockfilePath,
        retries: { retries: 10, factor: 1.5, minTimeout: 10, maxTimeout: 200 },
      })
      try {
        const current = await loadEncFile(paths.credentialsFile)
        const next = mutate(current)
        await writeEncFile(paths, next)
      } finally {
        await release().catch(() => {})
      }
    })(),
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
      return withCredentialsLock(paths, (data) => {
        data.entries[secretRef] = gcmEncrypt(key, Buffer.from(secretRef), secret)
        return data
      })
    },

    delete(secretRef: string): ResultAsync<void, CredentialError> {
      return withCredentialsLock(paths, (data) => {
        if (!(secretRef in data.entries)) return data
        const { [secretRef]: _removed, ...rest } = data.entries
        return { v: 1, entries: rest }
      })
    },
  }
}
