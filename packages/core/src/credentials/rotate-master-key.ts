// SPDX-License-Identifier: AGPL-3.0-only
// Master-key rotation (increment 32.3) — re-encrypts the encrypted-file vault under a
// new master key via a RECOVERABLE sequence. SECURITY: a crash must NEVER brick a secret.
//
// THE RECOVERY INVARIANT (the whole safety argument, one sentence — see method file §0b):
// While the fixed-name old-key sidecar `.master.key.old` exists, a rotation is in flight
// and the ONLY authoritative openable state is {pre-rekey ciphertext, OLD key}; recovery
// ALWAYS rolls back to it. Success is signalled by DELETING the sidecar (the last step).
// Recovery does NO key derivation / NO decrypt test to decide — it deterministically
// restores. Do not reintroduce "does it decrypt under key X" branches.
//
// Rotation writes go through writeFile0600/rename DIRECTLY, NEVER saveEncFile — its
// `finally` unconditionally releases the shared lock, which would drop rotation's own
// lock mid-sequence (MEDIUM-2).

import { randomBytes } from "node:crypto"
import { readFile, rename, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { err, ok, type Result, ResultAsync } from "neverthrow"
import type { CredentialError } from "../errors/index.js"
import { getLogger } from "../logging/index.js"
import type { JunctionPaths } from "../paths/index.js"
import { type MasterKeyTier, resolveMasterKeyWithTier } from "./master-key.js"
import {
  deriveKeyFromPassphrase,
  type EncFile,
  EncFileSchema,
  gcmDecrypt,
  gcmEncrypt,
  writeFile0600,
} from "./vault-crypto.js"

// ---------------------------------------------------------------------------
// Fixed artifact names (ALL under paths.home) — no <rand> suffix on any
// recovery-critical artifact (CRITICAL/HIGH-2: at most one in-flight rotation).
// ---------------------------------------------------------------------------

function rekeyTmpFile(paths: JunctionPaths): string {
  return `${paths.credentialsFile}.rekey.tmp`
}
function preRekeyFile(paths: JunctionPaths): string {
  return `${paths.credentialsFile}.pre-rekey`
}
function oldKeySidecar(paths: JunctionPaths): string {
  return path.join(paths.home, ".master.key.old")
}
function saltFile(paths: JunctionPaths): string {
  return `${paths.masterKeyFile}.salt`
}
function preRekeySaltFile(paths: JunctionPaths): string {
  return `${paths.masterKeyFile}.salt.pre-rekey`
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

/**
 * env-raw tier gate: junction cannot rewrite the operator's environment, so a raw-env
 * master key can only be rotated with the explicit `--print-new-key --i-understand`
 * escape hatch. Returns a `rotate-refused` Err when the gate is NOT satisfied, else null
 * (proceed). Shared by both the empty-vault and the main rotate paths so the refusal text
 * never drifts.
 */
function envRawPrintGate(
  tier: MasterKeyTier,
  opts: RotateMasterKeyOptions,
): Result<RotateResult, CredentialError> | null {
  if (tier.kind !== "env-raw") return null
  const wantsPrint = opts.printNewKey === true && opts.iUnderstand === true
  if (wantsPrint) return null
  return err<RotateResult, CredentialError>({
    kind: "rotate-refused",
    reason:
      "master key is supplied via JUNCTION_MASTER_KEY (env); junction cannot rewrite your environment. " +
      "To rotate: (1) vault export --out backup.jvlt  (2) set a new JUNCTION_MASTER_KEY  (3) vault import backup.jvlt. " +
      "Refused — nothing changed.",
  })
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch (e: unknown) {
    if (isNodeError(e) && e.code === "ENOENT") return false
    throw e
  }
}

async function unlinkBestEffort(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch (e: unknown) {
    if (!isNodeError(e) || e.code !== "ENOENT") throw e
  }
}

async function acquireLock(paths: JunctionPaths): Promise<() => Promise<void>> {
  const { lock } = await import("proper-lockfile")
  const lockfilePath = path.join(paths.home, ".credentials.lock")
  const release = await lock(paths.home, { lockfilePath })
  return async () => {
    await release().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RotateMasterKeyOptions {
  /** env-raw tier only: print the new key to the operator (requires iUnderstand too). */
  printNewKey?: boolean
  /** env-raw tier only: the explicit footgun acknowledgement (requires printNewKey too). */
  iUnderstand?: boolean
  /** env-passphrase tier only: the new passphrase to re-derive the key under. */
  newPassphrase?: string
  /**
   * Test seam: invoked (and AWAITED) after each numbered step of the sequence
   * (before the NEXT step runs). Crash-injection tests throw from this hook to
   * simulate a kill at that exact boundary; an async hook (e.g. corrupting the tmp
   * file) is awaited so its effect deterministically lands before the next step —
   * no race with the following read. NEVER set in production code paths.
   */
  afterStep?: (label: string) => void | Promise<void>
}

export interface RotateResult {
  tier: MasterKeyTier["kind"]
  rotated: boolean
  backupFile?: string
  /** ONLY present on the env-raw --print-new-key path. The sole key ever emitted. */
  newKeyForOperator?: string
  /** true on env-raw/env-passphrase: the running env still holds the OLD value. */
  pendingEnvUpdate?: true
}

// ---------------------------------------------------------------------------
// recoverInterruptedRekey — the single roll-back rule (§2, the correctness heart)
// ---------------------------------------------------------------------------

/**
 * Heals an interrupted rotation. FAST PATH: if `.master.key.old` does not exist,
 * returns immediately (one stat) — this is the only cost on a normal boot.
 *
 * If the sidecar exists, a rotation was interrupted at SOME point in steps 8a-10.
 * Rolls BACK deterministically — NO key derivation, NO decrypt test, NO disk
 * mutation beyond these restores (HIGH-1). Idempotent: safe to call twice, and
 * safe to call after a genuine success (sidecar already gone ⇒ no-op ⇒ can NEVER
 * roll back a completed rotation).
 */
export function recoverInterruptedRekey(
  paths: JunctionPaths,
  _env: NodeJS.ProcessEnv,
): ResultAsync<void, CredentialError> {
  return new ResultAsync<void, CredentialError>(
    (async () => {
      const sidecar = oldKeySidecar(paths)
      if (!(await exists(sidecar))) {
        return ok<void, CredentialError>(undefined) // fast path — nothing in flight
      }

      const releaseLock = await acquireLock(paths)
      try {
        // Re-check under the lock — another process may have completed recovery
        // between our first stat and acquiring the lock.
        if (!(await exists(sidecar))) {
          return ok<void, CredentialError>(undefined)
        }

        // Restore OLD ciphertext: if pre-rekey exists, the swap (8c/8d) had
        // started — rename it back over the live file. If pre-rekey is absent,
        // the swap hadn't happened yet — the live file is already the OLD
        // ciphertext; leave it. Either way, live file == OLD ciphertext after this.
        const preRekey = preRekeyFile(paths)
        if (await exists(preRekey)) {
          await rename(preRekey, paths.credentialsFile)
        }

        // Drop the half-written NEW file (best-effort).
        await unlinkBestEffort(rekeyTmpFile(paths))

        // Reinstall the OLD key at its tier so the OLD ciphertext opens.
        const oldKeyB64 = (await readFile(sidecar, "utf-8")).trim()
        const oldKey = Buffer.from(oldKeyB64, "base64")

        // file tier ONLY: restore the OLD key file. `paths.masterKeyFile` (the
        // raw key bytes, distinct from `.salt`) is written ONLY by the `file`
        // tier (master-key.ts's autoGenerateKey/resolveFromFile) — an env-raw
        // or env-passphrase vault never has one. Gate on "it already exists"
        // (a stat, not a decrypt/derive — HIGH-1 compliant) rather than writing
        // unconditionally: creating a NEW master.key where none existed would
        // itself be a tier-posture-downgrade artifact (a Tier-3 file appearing
        // next to a Tier-1 env vault), and would corrupt the empty-vault-crash
        // scenario where a file-tier master.key was never created before the
        // crash.
        //
        // NOTE: no keyring write here. §0b's keyring branch is explicitly
        // documented as defensive/unreachable ("a file store can't source its
        // key from keyring today") — writing `Entry("junction","__master_key__")`
        // here would mutate the SHARED OS keychain unconditionally on every
        // recovery, on every machine, even for a plain file/env-tier rotation
        // that never touched the keyring. That's a real side effect (it can
        // silently plant a keyring entry that then hijacks the NEXT
        // resolveMasterKeyWithTier call on this machine, since Tier 2 always
        // checks keyring regardless of JUNCTION_STORE) — not a harmless no-op.
        // If the keyring tier ever becomes reachable for a file store, recovery
        // must resolve the CURRENT tier (like rotateMasterKey step 2 does)
        // before deciding where to reinstall — never write speculatively.
        if (oldKey.length === 32 && (await exists(paths.masterKeyFile))) {
          await writeFile0600(paths.masterKeyFile, oldKey)
        }

        // env-passphrase tier: restore the OLD salt (CRITICAL-3) so the still-OLD
        // env passphrase re-derives the OLD key that opens the restored ciphertext.
        const preSalt = preRekeySaltFile(paths)
        if (await exists(preSalt)) {
          await rename(preSalt, saltFile(paths))
        }

        // env-raw tier: nothing to install — env still holds the OLD key, which
        // now opens the restored OLD ciphertext.

        // Clear the in-flight flag — this is the "recovered" signal.
        await unlinkBestEffort(sidecar)

        getLogger().warn(
          "recovered an interrupted master-key rotation; the vault was rolled back to its pre-rotation state",
        )
        return ok<void, CredentialError>(undefined)
      } catch (cause) {
        return err<void, CredentialError>({ kind: "rotate-failed", cause })
      } finally {
        await releaseLock()
      }
    })(),
  )
}

// ---------------------------------------------------------------------------
// rotateMasterKey — the recoverable re-key sequence (§1)
// ---------------------------------------------------------------------------

export function rotateMasterKey(
  paths: JunctionPaths,
  env: NodeJS.ProcessEnv,
  opts: RotateMasterKeyOptions = {},
): ResultAsync<RotateResult, CredentialError> {
  const afterStep = opts.afterStep ?? ((): void => {})

  return new ResultAsync<RotateResult, CredentialError>(
    (async () => {
      // Step 0: heal first — never stack two sidecars (HIGH-2).
      const healResult = await recoverInterruptedRekey(paths, env)
      if (healResult.isErr()) return err<RotateResult, CredentialError>(healResult.error)
      await afterStep("0-heal")

      // Step 1: acquire the lock (released in `finally` below).
      const releaseLock = await acquireLock(paths)
      try {
        // The ENTIRE steps 2-11 body is wrapped in its own try/catch so ANY
        // thrown error — including from the `afterStep` crash-injection seam,
        // or any unguarded fs operation — is caught and mapped to
        // `rotate-failed` rather than propagating as an unhandled rejection.
        // This is what makes the crash-injection test seam actually exercise
        // the recovery path instead of just throwing out of the whole
        // ResultAsync (which would never get a chance to leave a consistent
        // {sidecar, pre-rekey} state for recovery to find — every await below
        // that can throw happens strictly AFTER the artifact it corresponds to
        // was written, so a throw here always lands in a state recovery
        // already knows how to roll back).
        return await runRekeySequence(paths, env, opts, afterStep)
      } catch (cause) {
        return err<RotateResult, CredentialError>({ kind: "rotate-failed", cause })
      } finally {
        await releaseLock()
      }
    })(),
  )
}

async function runRekeySequence(
  paths: JunctionPaths,
  env: NodeJS.ProcessEnv,
  opts: RotateMasterKeyOptions,
  afterStep: (label: string) => void,
): Promise<Result<RotateResult, CredentialError>> {
  // Step 2: resolve OLD key + tier.
  const resolved = await resolveMasterKeyWithTier(paths, env)
  if (resolved.isErr()) return err<RotateResult, CredentialError>(resolved.error)
  const { key: oldKey, tier } = resolved.value

  if (tier.kind === "keyring") {
    // Defensive — cannot occur on a file store today (§0b).
    return err<RotateResult, CredentialError>({
      kind: "rotate-refused",
      reason:
        "master key is sourced from the OS keyring; there is no file-vault master key to rotate.",
    })
  }

  const envRawRefusal = envRawPrintGate(tier, opts)
  if (envRawRefusal !== null) return envRawRefusal

  if (tier.kind === "env-passphrase" && !opts.newPassphrase) {
    return err<RotateResult, CredentialError>({
      kind: "rotate-refused",
      reason:
        "master key is derived from a passphrase (JUNCTION_MASTER_KEY/_FILE); rotating requires a new " +
        "passphrase. Re-run with --new-passphrase-stdin.",
    })
  }
  await afterStep("2-resolve-old-key")

  // Step 3: EMPTY-VAULT branch — no credentials.enc.json means nothing to
  // re-encrypt; the first rename (8c) would ENOENT-throw. Rotate the key
  // IN PLACE, no file dance, no pre-rekey/sidecar.
  if (!(await exists(paths.credentialsFile))) {
    const installResult = await installNewKeyInPlace(paths, tier, opts)
    await afterStep("3-empty-vault-in-place")
    return installResult
  }

  // Step 4: load + decrypt ALL entries under the OLD key.
  const raw = await readFile(paths.credentialsFile, "utf-8")
  const liveFile = EncFileSchema.parse(JSON.parse(raw) as unknown)
  const plaintextByRef = new Map<string, string>()
  for (const [secretRef, record] of Object.entries(liveFile.entries)) {
    try {
      plaintextByRef.set(secretRef, gcmDecrypt(oldKey, Buffer.from(secretRef), record))
    } catch (cause) {
      // A pre-existing undecryptable entry — never silently drop a secret.
      return err<RotateResult, CredentialError>({ kind: "rotate-failed", cause })
    }
  }
  await afterStep("4-decrypt-all")

  // Step 5: generate the NEW key (or derive from new passphrase + fresh salt).
  let newKey: Buffer
  let newSalt: Buffer | undefined
  if (tier.kind === "env-passphrase") {
    newSalt = randomBytes(16)
    // biome-ignore lint/style/noNonNullAssertion: guarded above (opts.newPassphrase required)
    const derived = await deriveKeyFromPassphrase(opts.newPassphrase!, newSalt)
    if (derived.isErr()) return err<RotateResult, CredentialError>(derived.error)
    newKey = derived.value
  } else {
    newKey = randomBytes(32)
  }
  await afterStep("5-generate-new-key")

  // Step 6: re-encrypt all entries under the NEW key into the tmp file.
  const newEntries: EncFile["entries"] = {}
  for (const [secretRef, plaintext] of plaintextByRef) {
    newEntries[secretRef] = gcmEncrypt(newKey, Buffer.from(secretRef), plaintext)
  }
  const tmpFile = rekeyTmpFile(paths)
  const newFileContents: EncFile = { v: 1, entries: newEntries }
  await writeFile0600(tmpFile, Buffer.from(JSON.stringify(newFileContents), "utf-8"))
  await afterStep("6-write-tmp")

  // Step 7: verify-BEFORE-swap — re-read the tmp, and for every secretRef in
  // step 4's map, decrypt under the NEW key and compare. secretRef-keyed
  // (not a bare plaintext-set compare — MEDIUM-1).
  try {
    const tmpRaw = await readFile(tmpFile, "utf-8")
    const tmpParsed = EncFileSchema.parse(JSON.parse(tmpRaw) as unknown)
    const tmpKeys = new Set(Object.keys(tmpParsed.entries))
    const expectedKeys = new Set(plaintextByRef.keys())
    if (tmpKeys.size !== expectedKeys.size || [...expectedKeys].some((k) => !tmpKeys.has(k))) {
      // Caught by the enclosing try/catch below, converted to Result<RotateResult, CredentialError>.
      // nosemgrep: no-bare-throw-in-core -- category 3 (same-function try/catch): caught below, converted to a typed Result
      throw new Error("rekey tmp file key-set does not match the source key-set")
    }
    for (const [secretRef, expectedPlaintext] of plaintextByRef) {
      const record = tmpParsed.entries[secretRef]
      // nosemgrep: no-bare-throw-in-core -- category 3 (same-function try/catch), same enclosing try/catch as above
      if (record === undefined) throw new Error(`missing secretRef ${secretRef} in rekey tmp`)
      const decrypted = gcmDecrypt(newKey, Buffer.from(secretRef), record)
      if (decrypted !== expectedPlaintext) {
        // nosemgrep: no-bare-throw-in-core -- category 3 (same-function try/catch), same enclosing try/catch as above
        throw new Error(`verify mismatch for secretRef ${secretRef}`)
      }
    }
  } catch (cause) {
    await unlinkBestEffort(tmpFile)
    return err<RotateResult, CredentialError>({ kind: "rotate-failed", cause })
  }
  await afterStep("7-verify-before-swap")

  // Step 8: write the in-flight artifacts, THEN swap.
  // 8a. Persist OLD key to the sidecar. From here, sidecar-present ⇒ recovery rolls back.
  await writeFile0600(oldKeySidecar(paths), Buffer.from(oldKey.toString("base64"), "utf-8"))
  await afterStep("8a-write-sidecar")

  // 8b. env-passphrase only: back up the OLD salt BEFORE step 9 overwrites it (CRITICAL-3).
  if (tier.kind === "env-passphrase") {
    await rename(saltFile(paths), preRekeySaltFile(paths))
  }
  await afterStep("8b-backup-salt")

  // 8c. rename live -> pre-rekey.
  await rename(paths.credentialsFile, preRekeyFile(paths))
  await afterStep("8c-rename-live-to-pre-rekey")

  // 8d. rename tmp -> live.
  await rename(tmpFile, paths.credentialsFile)
  await afterStep("8d-rename-tmp-to-live")

  // Step 9: install the NEW key at the SAME tier.
  let newKeyForOperator: string | undefined
  if (tier.kind === "file") {
    await writeFile0600(paths.masterKeyFile, newKey)
  } else if (tier.kind === "env-passphrase") {
    // biome-ignore lint/style/noNonNullAssertion: assigned above on this tier
    await writeFile0600(saltFile(paths), newSalt!)
  } else if (tier.kind === "env-raw") {
    // Cannot install — operator installs it into their env.
    newKeyForOperator = newKey.toString("base64")
  }
  await afterStep("9-install-new-key")

  // Step 10: verify the live vault opens under the NEW key (smoke test).
  try {
    const verifyRaw = await readFile(paths.credentialsFile, "utf-8")
    const verifyParsed = EncFileSchema.parse(JSON.parse(verifyRaw) as unknown)
    const [firstRef] = plaintextByRef.keys()
    if (firstRef !== undefined) {
      const record = verifyParsed.entries[firstRef]
      // Caught by the enclosing try/catch below, converted to Result<RotateResult, CredentialError>.
      // nosemgrep: no-bare-throw-in-core -- category 3 (same-function try/catch): caught below, converted to a typed Result
      if (record === undefined) throw new Error("post-swap live file missing an entry")
      gcmDecrypt(newKey, Buffer.from(firstRef), record)
    }
  } catch (cause) {
    // On failure: do NOT delete the sidecar; let recovery roll back.
    return err<RotateResult, CredentialError>({ kind: "rotate-failed", cause })
  }
  await afterStep("10-verify-new-key")

  // Step 11: SUCCESS — delete the sidecar (the atomic "committed" signal).
  await unlinkBestEffort(oldKeySidecar(paths))
  if (tier.kind === "env-passphrase") {
    await unlinkBestEffort(preRekeySaltFile(paths))
  }
  // KEEP the pre-rekey backup — the operator's safety net.
  await afterStep("11-delete-sidecar")

  const pendingEnvUpdate: true | undefined =
    tier.kind === "env-raw" || tier.kind === "env-passphrase" ? true : undefined

  return ok<RotateResult, CredentialError>({
    tier: tier.kind,
    rotated: true,
    backupFile: preRekeyFile(paths),
    ...(newKeyForOperator !== undefined ? { newKeyForOperator } : {}),
    ...(pendingEnvUpdate !== undefined ? { pendingEnvUpdate } : {}),
  })
}

/**
 * Step 3 (empty-vault branch): install a fresh key at the tier with no file
 * dance, no pre-rekey/sidecar — there is nothing to re-encrypt.
 */
async function installNewKeyInPlace(
  paths: JunctionPaths,
  tier: MasterKeyTier,
  opts: RotateMasterKeyOptions,
): Promise<Result<RotateResult, CredentialError>> {
  const envRawRefusal = envRawPrintGate(tier, opts)
  if (envRawRefusal !== null) return envRawRefusal
  if (tier.kind === "env-raw") {
    const newKey = randomBytes(32)
    return ok<RotateResult, CredentialError>({
      tier: tier.kind,
      rotated: true,
      newKeyForOperator: newKey.toString("base64"),
      pendingEnvUpdate: true,
    })
  }

  if (tier.kind === "env-passphrase") {
    if (!opts.newPassphrase) {
      return err<RotateResult, CredentialError>({
        kind: "rotate-refused",
        reason:
          "master key is derived from a passphrase (JUNCTION_MASTER_KEY/_FILE); rotating requires a new " +
          "passphrase. Re-run with --new-passphrase-stdin.",
      })
    }
    const newSalt = randomBytes(16)
    const derived = await deriveKeyFromPassphrase(opts.newPassphrase, newSalt)
    if (derived.isErr()) return err<RotateResult, CredentialError>(derived.error)
    await writeFile0600(saltFile(paths), newSalt)
    return ok<RotateResult, CredentialError>({
      tier: tier.kind,
      rotated: true,
      pendingEnvUpdate: true,
    })
  }

  if (tier.kind === "keyring") {
    return err<RotateResult, CredentialError>({
      kind: "rotate-refused",
      reason:
        "master key is sourced from the OS keyring; there is no file-vault master key to rotate.",
    })
  }

  // file tier
  const newKey = randomBytes(32)
  await writeFile0600(paths.masterKeyFile, newKey)
  return ok<RotateResult, CredentialError>({ tier: tier.kind, rotated: true })
}
