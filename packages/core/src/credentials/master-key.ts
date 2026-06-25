// SPDX-License-Identifier: AGPL-3.0-only
// Master-key resolver — 4-tier priority ladder → ResultAsync<Buffer(32), CredentialError>.
// SECURITY: the master key MUST NOT be logged, put in error messages, or returned to callers.
//
// THREAT MODEL (Tier 3): the auto-key lives next to the ciphertext in ~/.junction.
// This does NOT protect against an attacker who can read ~/.junction — they get both
// master.key and credentials.enc.json. What it DOES guarantee:
// (a) DB leaks are harmless — only secret_ref handles (ULIDs), never plaintext.
// (b) Backup/partial exposure (log, screenshot, git add) of the DB alone leaks nothing.
// For real at-rest protection, supply Tier 1 (systemd LoadCredential / passphrase not on disk).

import { randomBytes, scrypt } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { err, ok, ResultAsync } from "neverthrow"
import type { CredentialError } from "../errors/index.js"
import type { JunctionPaths } from "../paths/index.js"

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

/**
 * Decode a strict base64 or hex string to exactly 32 bytes, or return null.
 * The encodings are validated by exact-shape regex (43/44-char base64, 64-char hex)
 * BEFORE decoding, so an ordinary passphrase is never silently mis-read as a raw key.
 */
function tryDecodeKey(value: string): Buffer | null {
  // 32 bytes base64 = 43 chars (no padding) or 44 chars (one "=" pad).
  if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    const decoded = Buffer.from(value, "base64")
    if (decoded.length === 32) return decoded
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex")
  return null
}

/** Derive a 32-byte key from a passphrase with scrypt (real production params + mandatory maxmem). */
function deriveKeyFromPassphrase(
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

/** Resolve from JUNCTION_MASTER_KEY_FILE or JUNCTION_MASTER_KEY env var. */
async function resolveFromEnv(
  env: NodeJS.ProcessEnv,
): Promise<{ key: Buffer } | { passphrase: string } | null> {
  const keyFilePath = env.JUNCTION_MASTER_KEY_FILE?.trim()
  if (keyFilePath) {
    const raw = (await readFile(keyFilePath, "utf-8")).trim()
    const decoded = tryDecodeKey(raw)
    if (decoded !== null) return { key: decoded }
    return { passphrase: raw }
  }
  const keyValue = env.JUNCTION_MASTER_KEY?.trim()
  if (keyValue) {
    const decoded = tryDecodeKey(keyValue)
    if (decoded !== null) return { key: decoded }
    return { passphrase: keyValue }
  }
  return null
}

/** Write a buffer atomically at mode 0600 (chmod the tmp file before rename). */
async function writeFile0600(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`
  await writeFile(tmp, data)
  await chmod(tmp, 0o600)
  await rename(tmp, target)
}

/** Auto-generate a 32-byte key, write atomically to masterKeyFile at mode 0600. */
async function autoGenerateKey(masterKeyFile: string): Promise<Buffer> {
  const key = randomBytes(32)
  await writeFile0600(masterKeyFile, key)
  return key
}

/**
 * Load the persisted 16-byte passphrase salt, or generate + persist one (0600).
 * The salt MUST be stable across restarts — scrypt is deterministic only for a fixed
 * salt, so a fresh salt each boot would derive a different key and brick prior ciphertext.
 * The salt is not secret; persisting it is required for correctness, not confidentiality.
 */
async function loadOrCreateSalt(masterKeyFile: string): Promise<Buffer> {
  const saltFile = `${masterKeyFile}.salt`
  try {
    const existing = await readFile(saltFile)
    if (existing.length === 16) return existing
  } catch (e: unknown) {
    if (!isNodeError(e) || e.code !== "ENOENT") throw e
  }
  const salt = randomBytes(16)
  await writeFile0600(saltFile, salt)
  return salt
}

/** Load existing key at masterKeyFile, or auto-generate one. */
async function resolveFromFile(masterKeyFile: string): Promise<Buffer> {
  try {
    const data = await readFile(masterKeyFile)
    if (data.length === 32) return data
    // Wrong size — regenerate
  } catch (e: unknown) {
    if (!isNodeError(e) || e.code !== "ENOENT") throw e
  }
  return autoGenerateKey(masterKeyFile)
}

/**
 * Resolves the 32-byte master key using the 4-tier priority ladder:
 * 1. JUNCTION_MASTER_KEY / JUNCTION_MASTER_KEY_FILE (32B base64/hex or passphrase→scrypt)
 * 2. OS keyring Entry("junction","__master_key__")
 * 3. Auto-generated key at ~/.junction/master.key (mode 0600) — zero-config default
 * 4. Passphrase prompt (stub — not implemented for unattended boot)
 */
export function resolveMasterKey(
  paths: JunctionPaths,
  env: NodeJS.ProcessEnv = process.env,
): ResultAsync<Buffer, CredentialError> {
  return new ResultAsync<Buffer, CredentialError>(
    (async () => {
      // Tier 1: env key
      let envResult: { key: Buffer } | { passphrase: string } | null = null
      try {
        envResult = await resolveFromEnv(env)
      } catch (cause) {
        return err<Buffer, CredentialError>({ kind: "key-unavailable", cause })
      }

      if (envResult !== null) {
        if ("key" in envResult) return ok<Buffer, CredentialError>(envResult.key)
        // Passphrase → scrypt with a persisted salt so the key is stable across restarts.
        let salt: Buffer
        try {
          salt = await loadOrCreateSalt(paths.masterKeyFile)
        } catch (cause) {
          return err<Buffer, CredentialError>({ kind: "key-unavailable", cause })
        }
        return deriveKeyFromPassphrase(envResult.passphrase, salt)
      }

      // Tier 2: OS keyring (lazy-import; skip gracefully if unavailable)
      try {
        const { Entry } = await import("@napi-rs/keyring")
        const stored = new Entry("junction", "__master_key__").getPassword()
        if (stored !== null) {
          const decoded = Buffer.from(stored, "base64")
          if (decoded.length === 32) return ok<Buffer, CredentialError>(decoded)
        }
      } catch {
        // Keyring unavailable — fall through to Tier 3
      }

      // Tier 3: auto-generated file key
      try {
        const key = await resolveFromFile(paths.masterKeyFile)
        return ok<Buffer, CredentialError>(key)
      } catch (cause) {
        return err<Buffer, CredentialError>({ kind: "key-unavailable", cause })
      }
    })(),
  )
}
