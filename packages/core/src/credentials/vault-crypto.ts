// SPDX-License-Identifier: AGPL-3.0-only
// Shared AES-256-GCM + scrypt vault primitives — the ONE home for the crypto that the
// encrypted-file store, master-key rotation (32.3), and vault export/import (32.4) all reuse.
// SECURITY: never logs keys/plaintext; scrypt params declared ONCE here (the maxmem gotcha).

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto"
import { chmod, rename, writeFile } from "node:fs/promises"
import { err, ok, ResultAsync } from "neverthrow"
import { z } from "zod"
import type { CredentialError } from "../errors/index.js"

// ---- on-disk enc-file schema (moved verbatim from encrypted-file-store.ts) ----

export const EncRecordSchema = z.object({
  iv: z.string(),
  tag: z.string(),
  ct: z.string(),
})
export type EncRecord = z.infer<typeof EncRecordSchema>

export const EncFileSchema = z.object({
  v: z.literal(1),
  entries: z.record(z.string(), EncRecordSchema),
})
export type EncFile = z.infer<typeof EncFileSchema>

// ---- AES-256-GCM (generalized AAD) ----

/**
 * Encrypt plaintext under a 32-byte key with a fresh 12-byte IV. `aad` binds the ciphertext
 * to its context (store: Buffer.from(secretRef); archive: the header bytes).
 */
export function gcmEncrypt(key: Buffer, aad: Buffer, plaintext: string): EncRecord {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  }
}

/**
 * Decrypts a record. Throws if the auth tag does not match — caller maps throw → decrypt-failed.
 * setAuthTag MUST be called before final() to enforce GCM integrity.
 */
export function gcmDecrypt(key: Buffer, aad: Buffer, record: EncRecord): string {
  const iv = Buffer.from(record.iv, "base64")
  const tag = Buffer.from(record.tag, "base64")
  const ct = Buffer.from(record.ct, "base64")
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag) // MUST precede final() — a mismatch makes final() throw
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
  return plaintext.toString("utf-8")
}

// ---- scrypt (params declared ONCE — do not duplicate; the maxmem gotcha) ----

/** Derive a 32-byte key from a passphrase with scrypt (real production params + mandatory maxmem). */
export function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Buffer,
): ResultAsync<Buffer, CredentialError> {
  return new ResultAsync<Buffer, CredentialError>(
    new Promise((resolve) => {
      scrypt(
        passphrase,
        salt,
        32,
        // maxmem MUST be 256 MiB — Node's default 32 MiB throws at N=2^17
        { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
        (error, derivedKey) => {
          if (error !== null) {
            resolve(err<Buffer, CredentialError>({ kind: "key-unavailable", cause: error }))
          } else {
            resolve(ok<Buffer, CredentialError>(derivedKey))
          }
        },
      )
    }),
  )
}

// ---- atomic 0600 write ----

/**
 * Write a buffer atomically at mode 0600.
 *
 * Security: the tmp file is created at 0600 immediately (not at the umask default 0644)
 * so the raw key material is NEVER briefly world-readable between writeFile and chmod.
 * The post-rename chmod is kept as belt-and-suspenders (handles cross-device rename edge
 * cases where the destination inherits different umask behavior on some Linux kernels).
 */
export async function writeFile0600(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`
  // FIX 1: mode 0o600 here closes the world-readable window that existed between writeFile
  // and chmod. POSIX honors the mode under umask for newly created files.
  await writeFile(tmp, data, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, target)
}
