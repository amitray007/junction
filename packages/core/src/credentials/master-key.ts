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
 * Decode a strict base64 or hex string to exactly 32 bytes, or return a classified result.
 *
 * Returns:
 *   { kind: "key", value: Buffer }  — matched raw-key shape AND decoded to exactly 32 bytes.
 *   { kind: "shape-mismatch" }       — matched raw-key shape but decoded to ≠32 bytes (near-miss).
 *   null                             — does not match any raw-key shape (treat as passphrase).
 *
 * Shape check runs BEFORE decoding so an ordinary passphrase is never silently mis-read as a
 * raw key, AND a clearly-intended-but-wrong raw key (e.g. truncated hex) is never silently
 * downgraded to the passphrase/scrypt path.
 */
function tryDecodeKey(
  value: string,
): { kind: "key"; value: Buffer } | { kind: "shape-mismatch" } | null {
  // 32 bytes base64 = 43 chars (no padding) or 44 chars (one "=" pad).
  if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    const decoded = Buffer.from(value, "base64")
    if (decoded.length === 32) return { kind: "key", value: decoded }
    return { kind: "shape-mismatch" }
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const decoded = Buffer.from(value, "hex")
    if (decoded.length === 32) return { kind: "key", value: decoded }
    return { kind: "shape-mismatch" }
  }
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

/**
 * Resolve from JUNCTION_MASTER_KEY_FILE or JUNCTION_MASTER_KEY env var.
 *
 * Returns:
 *   { key: Buffer }        — a valid 32-byte raw key.
 *   { passphrase: string } — a genuine passphrase (not raw-key-shaped) → scrypt.
 *   { near-miss: true }    — value matches a raw-key shape but decodes to ≠32 bytes;
 *                            operator clearly intended a raw key → must not silently
 *                            downgrade to scrypt (would derive a DIFFERENT key and
 *                            persist a salt, weakening the operator's intended Tier-1
 *                            at-rest posture). Caller maps this to key-unavailable Err.
 *   null                   — no env var set.
 */
async function resolveFromEnv(
  env: NodeJS.ProcessEnv,
): Promise<{ key: Buffer } | { passphrase: string } | { nearMiss: true } | null> {
  const keyFilePath = env.JUNCTION_MASTER_KEY_FILE?.trim()
  if (keyFilePath) {
    const raw = (await readFile(keyFilePath, "utf-8")).trim()
    const decoded = tryDecodeKey(raw)
    if (decoded === null) return { passphrase: raw }
    if (decoded.kind === "shape-mismatch") return { nearMiss: true }
    return { key: decoded.value }
  }
  const keyValue = env.JUNCTION_MASTER_KEY?.trim()
  if (keyValue) {
    const decoded = tryDecodeKey(keyValue)
    if (decoded === null) return { passphrase: keyValue }
    if (decoded.kind === "shape-mismatch") return { nearMiss: true }
    return { key: decoded.value }
  }
  return null
}

/**
 * Write a buffer atomically at mode 0600.
 *
 * Security: the tmp file is created at 0600 immediately (not at the umask default 0644)
 * so the raw key material is NEVER briefly world-readable between writeFile and chmod.
 * The post-rename chmod is kept as belt-and-suspenders (handles cross-device rename edge
 * cases where the destination inherits different umask behavior on some Linux kernels).
 */
async function writeFile0600(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`
  // FIX 1: mode 0o600 here closes the world-readable window that existed between writeFile
  // and chmod. POSIX honors the mode under umask for newly created files.
  await writeFile(tmp, data, { mode: 0o600 })
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
      let envResult: { key: Buffer } | { passphrase: string } | { nearMiss: true } | null = null
      try {
        envResult = await resolveFromEnv(env)
      } catch (cause) {
        return err<Buffer, CredentialError>({ kind: "key-unavailable", cause })
      }

      if (envResult !== null) {
        if ("key" in envResult) return ok<Buffer, CredentialError>(envResult.key)
        // FIX 3: value matched a raw-key shape (base64/hex length) but decoded to ≠32 bytes.
        // The operator clearly intended a raw key — do NOT silently downgrade to scrypt, which
        // would derive a different key and persist a salt to disk, silently weakening their
        // intended Tier-1 at-rest posture. Fail explicitly so the misconfiguration is visible.
        if ("nearMiss" in envResult) {
          return err<Buffer, CredentialError>({
            kind: "key-unavailable",
            cause: new Error(
              "JUNCTION_MASTER_KEY/_FILE matches a raw-key shape (base64/hex) but does not decode to exactly 32 bytes. " +
                "Fix the key value or use a non-raw-key-shaped passphrase.",
            ),
          })
        }
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
          // FIX 4: a present-but-malformed keyring master key must NOT silently fall through
          // to Tier 3 (auto-generated file key). Silent fallthrough would derive a DIFFERENT
          // key for future writes while prior ciphertext was encrypted with the (corrupt)
          // keyring key, bricking all previously-stored secrets.
          // Absent keyring entry (stored === null) still falls through to Tier 3 normally.
          if (decoded.length !== 32) {
            return err<Buffer, CredentialError>({
              kind: "key-unavailable",
              cause: new Error(
                `OS keyring master key decodes to ${decoded.length} bytes, expected 32. ` +
                  "Delete the malformed keyring entry or correct it before restarting.",
              ),
            })
          }
          return ok<Buffer, CredentialError>(decoded)
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
