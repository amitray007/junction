// SPDX-License-Identifier: AGPL-3.0-only
// EncryptedFileStore — AES-256-GCM credential store backed by ~/.junction/credentials.enc.json.
// SECURITY: fresh IV per set(), auth-tag verified before final(), AAD = secretRef.
// NEVER logs the key, plaintext, or the full encrypted map. NEVER puts secret values in error cause.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { err, ok, ResultAsync } from "neverthrow"
import { z } from "zod"
import type { CredentialError } from "../errors/index.js"
import type { JunctionPaths } from "../paths/index.js"
import type { CredentialStore } from "./store.js"

// ---- on-disk schema ----

const EncRecordSchema = z.object({
  iv: z.string(),
  tag: z.string(),
  ct: z.string(),
})
type EncRecord = z.infer<typeof EncRecordSchema>

const EncFileSchema = z.object({
  v: z.literal(1),
  entries: z.record(z.string(), EncRecordSchema),
})
type EncFile = z.infer<typeof EncFileSchema>

// ---- helpers ----

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

async function loadEncFile(credentialsFile: string): Promise<EncFile> {
  try {
    const raw = await readFile(credentialsFile, "utf-8")
    return EncFileSchema.parse(JSON.parse(raw) as unknown)
  } catch (e: unknown) {
    if (isNodeError(e) && e.code === "ENOENT") return { v: 1, entries: {} }
    if (e instanceof SyntaxError) return { v: 1, entries: {} }
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
    await writeFile(tmp, JSON.stringify(data), "utf-8")
    await rename(tmp, paths.credentialsFile)
    await chmod(paths.credentialsFile, 0o600)
  } finally {
    await unlink(tmp).catch(() => {})
    if (release) await release().catch(() => {})
  }
}

function encryptRecord(key: Buffer, secretRef: string, plaintext: string): EncRecord {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(secretRef))
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
function decryptRecord(key: Buffer, secretRef: string, record: EncRecord): string {
  const iv = Buffer.from(record.iv, "base64")
  const tag = Buffer.from(record.tag, "base64")
  const ct = Buffer.from(record.ct, "base64")
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAAD(Buffer.from(secretRef))
  decipher.setAuthTag(tag) // MUST precede final() — a mismatch makes final() throw
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
  return plaintext.toString("utf-8")
}

// ---- store ----

export function createEncryptedFileStore(paths: JunctionPaths, key: Buffer): CredentialStore {
  return {
    backend: "encrypted-file",

    get(secretRef: string): ResultAsync<string | null, CredentialError> {
      return new ResultAsync<string | null, CredentialError>(
        (async () => {
          let data: EncFile
          try {
            data = await loadEncFile(paths.credentialsFile)
          } catch (cause) {
            return err<string | null, CredentialError>({ kind: "io-failed", cause })
          }
          const record = data.entries[secretRef]
          if (record === undefined) return ok<string | null, CredentialError>(null)
          try {
            const plaintext = decryptRecord(key, secretRef, record)
            return ok<string | null, CredentialError>(plaintext)
          } catch (cause) {
            // SECURITY: never return partial plaintext; cause is the GCM auth failure (no secret data)
            return err<string | null, CredentialError>({ kind: "decrypt-failed", cause })
          }
        })(),
      )
    },

    set(secretRef: string, secret: string): ResultAsync<void, CredentialError> {
      return new ResultAsync<void, CredentialError>(
        (async () => {
          let data: EncFile
          try {
            data = await loadEncFile(paths.credentialsFile)
          } catch (cause) {
            return err<void, CredentialError>({ kind: "io-failed", cause })
          }
          data.entries[secretRef] = encryptRecord(key, secretRef, secret)
          try {
            await saveEncFile(paths, data)
            return ok<void, CredentialError>(undefined)
          } catch (cause) {
            return err<void, CredentialError>({ kind: "io-failed", cause })
          }
        })(),
      )
    },

    delete(secretRef: string): ResultAsync<void, CredentialError> {
      return new ResultAsync<void, CredentialError>(
        (async () => {
          let data: EncFile
          try {
            data = await loadEncFile(paths.credentialsFile)
          } catch (cause) {
            return err<void, CredentialError>({ kind: "io-failed", cause })
          }
          if (!(secretRef in data.entries)) return ok<void, CredentialError>(undefined)
          const { [secretRef]: _removed, ...rest } = data.entries
          try {
            await saveEncFile(paths, { v: 1, entries: rest })
            return ok<void, CredentialError>(undefined)
          } catch (cause) {
            return err<void, CredentialError>({ kind: "io-failed", cause })
          }
        })(),
      )
    },
  }
}
