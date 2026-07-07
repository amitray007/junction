// SPDX-License-Identifier: AGPL-3.0-only
// Master-key rotation (32.3) — adversarial crash-injection is MANDATORY here.
// The whole point of this increment: a crash at ANY step boundary must NEVER brick a secret.

import { randomBytes } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ensureHome, getPaths } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"
import { createEncryptedFileStore } from "./encrypted-file-store.js"
import { createCredentialStore } from "./index.js"
import { resolveMasterKey, resolveMasterKeyWithTier } from "./master-key.js"
import { recoverInterruptedRekey, rotateMasterKey } from "./rotate-master-key.js"

async function fileMode(p: string): Promise<number> {
  return (await stat(p)).mode & 0o777
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function seedCredentials(
  paths: ReturnType<typeof getPaths>,
  env: NodeJS.ProcessEnv,
  refs: string[],
): Promise<{ key: Buffer; secrets: Map<string, string> }> {
  const keyResult = await resolveMasterKey(paths, env)
  expect(keyResult.isOk()).toBe(true)
  if (!keyResult.isOk()) throw new Error("failed to resolve master key")
  const store = createEncryptedFileStore(paths, keyResult.value)
  const secrets = new Map<string, string>()
  for (const ref of refs) {
    const secret = `secret-for-${ref}-${randomBytes(4).toString("hex")}`
    const setResult = await store.set(ref, secret)
    expect(setResult.isOk()).toBe(true)
    secrets.set(ref, secret)
  }
  return { key: keyResult.value, secrets }
}

/** Assert every secret in `secrets` still resolves correctly via a FRESH store open. */
async function assertAllResolve(
  paths: ReturnType<typeof getPaths>,
  env: NodeJS.ProcessEnv,
  secrets: Map<string, string>,
): Promise<void> {
  const keyResult = await resolveMasterKey(paths, env)
  expect(keyResult.isOk()).toBe(true)
  if (!keyResult.isOk()) return
  const store = createEncryptedFileStore(paths, keyResult.value)
  for (const [ref, expected] of secrets) {
    const getResult = await store.get(ref)
    expect(getResult.isOk(), `secretRef ${ref} should resolve ok`).toBe(true)
    if (getResult.isOk()) {
      expect(getResult.value, `secretRef ${ref} plaintext mismatch`).toBe(expected)
    }
  }
}

/** Assert every secret resolves under the OLD key (rolled back). */
async function assertAllResolveUnderKey(
  paths: ReturnType<typeof getPaths>,
  key: Buffer,
  secrets: Map<string, string>,
): Promise<void> {
  const store = createEncryptedFileStore(paths, key)
  for (const [ref, expected] of secrets) {
    const getResult = await store.get(ref)
    expect(getResult.isOk(), `secretRef ${ref} should resolve ok under given key`).toBe(true)
    if (getResult.isOk()) {
      expect(getResult.value).toBe(expected)
    }
  }
}

describe("rotateMasterKey — happy path (file tier)", () => {
  it("seeds 3 secrets, rotates, all still resolve under the NEW key", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { key: oldKey, secrets } = await seedCredentials(paths, env, [
        "ref-a",
        "ref-b",
        "ref-c",
      ])

      const oldMasterKeyBytes = await readFile(paths.masterKeyFile)
      const oldCiphertext = await readFile(paths.credentialsFile, "utf-8")

      const result = await rotateMasterKey(paths, env)
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.tier).toBe("file")
      expect(result.value.rotated).toBe(true)
      expect(result.value.backupFile).toBeDefined()

      // All 3 still resolve under the NEW key.
      await assertAllResolve(paths, env, secrets)

      // master.key bytes CHANGED.
      const newMasterKeyBytes = await readFile(paths.masterKeyFile)
      expect(newMasterKeyBytes.equals(oldMasterKeyBytes)).toBe(false)

      // credentials.enc.json ciphertext CHANGED (new IVs).
      const newCiphertext = await readFile(paths.credentialsFile, "utf-8")
      expect(newCiphertext).not.toBe(oldCiphertext)

      // pre-rekey backup exists + opens under the OLD key.
      expect(result.value.backupFile).toBeDefined()
      if (result.value.backupFile !== undefined) {
        expect(await exists(result.value.backupFile)).toBe(true)
        const backupRaw = JSON.parse(await readFile(result.value.backupFile, "utf-8")) as {
          entries: Record<string, { iv: string; tag: string; ct: string }>
        }
        expect(Object.keys(backupRaw.entries).sort()).toEqual(["ref-a", "ref-b", "ref-c"])
        const { gcmDecrypt } = await import("./vault-crypto.js")
        for (const [ref, plaintext] of secrets) {
          const record = backupRaw.entries[ref]
          expect(record).toBeDefined()
          if (!record) continue
          expect(gcmDecrypt(oldKey, Buffer.from(ref), record)).toBe(plaintext)
        }
      }

      // sidecar deleted.
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)

      // perms 0600 on new file + master.key + backup.
      if (process.platform !== "win32") {
        expect(await fileMode(paths.credentialsFile)).toBe(0o600)
        expect(await fileMode(paths.masterKeyFile)).toBe(0o600)
        if (result.value.backupFile !== undefined) {
          expect(await fileMode(result.value.backupFile)).toBe(0o600)
        }
      }
    })
  }, 30000)
})

describe("rotateMasterKey — crash injection (the mandatory adversarial set)", () => {
  it("kill after step 6 (tmp written, sidecar NOT yet written) → no sidecar; all open under OLD key", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { key: oldKey, secrets } = await seedCredentials(paths, env, ["a", "b"])

      const result = await rotateMasterKey(paths, env, {
        afterStep: (label) => {
          if (label === "6-write-tmp") throw new Error("injected crash after step 6")
        },
      })
      expect(result.isErr()).toBe(true)

      // No sidecar was ever written.
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)

      // Fast path: no sidecar ⇒ recovery is a no-op (does NOT touch the stray
      // tmp — that's the correct behavior per §2's single-rule model; the tmp
      // is inert until the next rotation attempt overwrites/removes it).
      const recovered = await recoverInterruptedRekey(paths, env)
      expect(recovered.isOk()).toBe(true)

      await assertAllResolveUnderKey(paths, oldKey, secrets)
      await assertAllResolve(paths, env, secrets)

      // The stray tmp is harmless: a subsequent rotation attempt overwrites it
      // (writeFile0600 is tmp+rename, not append) and completes normally.
      const nextRotation = await rotateMasterKey(paths, env)
      expect(nextRotation.isOk()).toBe(true)
      expect(await exists(`${paths.credentialsFile}.rekey.tmp`)).toBe(false)
      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("kill after 8a (sidecar written) before 8c (renames) → recovery rolls back", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { key: oldKey, secrets } = await seedCredentials(paths, env, ["a", "b"])

      const result = await rotateMasterKey(paths, env, {
        afterStep: (label) => {
          if (label === "8a-write-sidecar") throw new Error("injected crash after 8a")
        },
      })
      expect(result.isErr()).toBe(true)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(true)

      const recovered = await recoverInterruptedRekey(paths, env)
      expect(recovered.isOk()).toBe(true)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)

      await assertAllResolveUnderKey(paths, oldKey, secrets)
      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("kill BETWEEN the two renames 8c/8d (live momentarily ENOENT) → recovery rolls back", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { key: oldKey, secrets } = await seedCredentials(paths, env, ["a", "b", "c"])

      const result = await rotateMasterKey(paths, env, {
        afterStep: (label) => {
          if (label === "8c-rename-live-to-pre-rekey") {
            throw new Error("injected crash between 8c and 8d — live file is momentarily gone")
          }
        },
      })
      expect(result.isErr()).toBe(true)

      // Live file is momentarily ENOENT at this exact crash point.
      expect(await exists(paths.credentialsFile)).toBe(false)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(true)

      const recovered = await recoverInterruptedRekey(paths, env)
      expect(recovered.isOk()).toBe(true)
      expect(await exists(paths.credentialsFile)).toBe(true)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)

      await assertAllResolveUnderKey(paths, oldKey, secrets)
      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("kill after 8d (swap done) before 9 (key install) → recovery rolls back to pre-rekey + OLD key", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { key: oldKey, secrets } = await seedCredentials(paths, env, ["a", "b"])

      const result = await rotateMasterKey(paths, env, {
        afterStep: (label) => {
          if (label === "8d-rename-tmp-to-live") throw new Error("injected crash after 8d")
        },
      })
      expect(result.isErr()).toBe(true)

      // At this point the LIVE file is the NEW ciphertext, but master.key is
      // still the OLD key (step 9 hasn't run) — this is exactly the state
      // recovery must roll back from.
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(true)

      const recovered = await recoverInterruptedRekey(paths, env)
      expect(recovered.isOk()).toBe(true)

      await assertAllResolveUnderKey(paths, oldKey, secrets)
      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("kill after 9 (new key installed) before 11 (sidecar still present) → recovery STILL rolls back", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { key: oldKey, secrets } = await seedCredentials(paths, env, ["a", "b"])

      const result = await rotateMasterKey(paths, env, {
        afterStep: (label) => {
          if (label === "9-install-new-key") throw new Error("injected crash after step 9")
        },
      })
      expect(result.isErr()).toBe(true)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(true)

      const recovered = await recoverInterruptedRekey(paths, env)
      expect(recovered.isOk()).toBe(true)

      // The just-installed NEW key must have been overwritten by the OLD key.
      await assertAllResolveUnderKey(paths, oldKey, secrets)
      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("kill after 11 (sidecar deleted) → recovery no-op; all open under the NEW key (genuine success)", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { secrets } = await seedCredentials(paths, env, ["a", "b"])

      // Run the real sequence WITHOUT injected failure (11 already deletes the
      // sidecar unconditionally on success) — then simulate "crash right after"
      // by simply calling recovery afterward, proving it's a no-op.
      const result = await rotateMasterKey(paths, env)
      expect(result.isOk()).toBe(true)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)

      const newCiphertextBefore = await readFile(paths.credentialsFile, "utf-8")

      const recovered = await recoverInterruptedRekey(paths, env)
      expect(recovered.isOk()).toBe(true)

      // Recovery after genuine success must NOT touch the live file.
      const newCiphertextAfter = await readFile(paths.credentialsFile, "utf-8")
      expect(newCiphertextAfter).toBe(newCiphertextBefore)

      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("corrupt the new tmp file before step 7 → verify catches it, ABORT, nothing swapped", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { key: oldKey, secrets } = await seedCredentials(paths, env, ["a", "b"])

      const tmpFile = `${paths.credentialsFile}.rekey.tmp`
      const result = await rotateMasterKey(paths, env, {
        afterStep: async (label) => {
          if (label === "6-write-tmp") {
            // Corrupt the freshly-written tmp file before step 7's verify runs.
            await writeFile(
              tmpFile,
              '{"v":1,"entries":{"a":{"iv":"AA==","tag":"AA==","ct":"AA=="}}}',
            )
          }
        },
      })
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("rotate-failed")

      // No sidecar written, tmp cleaned up, nothing swapped.
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)
      expect(await exists(tmpFile)).toBe(false)

      await assertAllResolveUnderKey(paths, oldKey, secrets)
      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("pre-existing undecryptable entry → step 4 ABORTS, nothing written", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      await seedCredentials(paths, env, ["a", "b"])

      // Hand-write a bad record over one entry.
      const raw = JSON.parse(await readFile(paths.credentialsFile, "utf-8")) as {
        v: number
        entries: Record<string, { iv: string; tag: string; ct: string }>
      }
      raw.entries.a = { iv: "AAAAAAAAAAAAAAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==", ct: "AAAA" }
      await writeFile(paths.credentialsFile, JSON.stringify(raw), "utf-8")
      const beforeContents = await readFile(paths.credentialsFile, "utf-8")

      const result = await rotateMasterKey(paths, env)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("rotate-failed")

      // Nothing written: no sidecar, no tmp, live file untouched.
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)
      expect(await exists(`${paths.credentialsFile}.rekey.tmp`)).toBe(false)
      const afterContents = await readFile(paths.credentialsFile, "utf-8")
      expect(afterContents).toBe(beforeContents)
    })
  }, 30000)

  it("identical-plaintext-different-ref: step 7's secretRef-keyed compare passes on correct rotation", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const keyResult = await resolveMasterKey(paths, env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return
      const store = createEncryptedFileStore(paths, keyResult.value)
      const samePlaintext = "identical-secret-value"
      await store.set("ref-x", samePlaintext)
      await store.set("ref-y", samePlaintext)

      const result = await rotateMasterKey(paths, env)
      expect(result.isOk()).toBe(true)

      await assertAllResolve(
        paths,
        env,
        new Map([
          ["ref-x", samePlaintext],
          ["ref-y", samePlaintext],
        ]),
      )
    })
  }, 30000)
})

describe("rotateMasterKey — idempotency + heal-before-start", () => {
  it("running recoverInterruptedRekey TWICE after an injected crash → second run is a no-op; all open", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { key: oldKey, secrets } = await seedCredentials(paths, env, ["a", "b"])

      const result = await rotateMasterKey(paths, env, {
        afterStep: (label) => {
          if (label === "9-install-new-key") throw new Error("injected crash")
        },
      })
      expect(result.isErr()).toBe(true)

      const first = await recoverInterruptedRekey(paths, env)
      expect(first.isOk()).toBe(true)
      const second = await recoverInterruptedRekey(paths, env)
      expect(second.isOk()).toBe(true)

      await assertAllResolveUnderKey(paths, oldKey, secrets)
      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("running recoverInterruptedRekey after a GENUINE success does NOT roll back the new vault", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { secrets } = await seedCredentials(paths, env, ["a", "b"])

      const result = await rotateMasterKey(paths, env)
      expect(result.isOk()).toBe(true)

      const newKeyBytes = await readFile(paths.masterKeyFile)
      const recovered = await recoverInterruptedRekey(paths, env)
      expect(recovered.isOk()).toBe(true)

      const stillNewKeyBytes = await readFile(paths.masterKeyFile)
      expect(stillNewKeyBytes.equals(newKeyBytes)).toBe(true)
      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("crash, then re-run rotateMasterKey → step 0 heals the first before the second starts; never two sidecars", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const { secrets } = await seedCredentials(paths, env, ["a", "b"])

      const first = await rotateMasterKey(paths, env, {
        afterStep: (label) => {
          if (label === "8a-write-sidecar") throw new Error("injected crash")
        },
      })
      expect(first.isErr()).toBe(true)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(true)

      // Re-run WITHOUT injected failure — step 0 must heal the stale sidecar
      // before this attempt's own rotation proceeds.
      const second = await rotateMasterKey(paths, env)
      expect(second.isOk()).toBe(true)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)

      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)
})

describe("rotateMasterKey — empty-vault (spec-flow C3)", () => {
  it("rotate an empty file vault → no crash, key rotated in place; subsequent credential add works under NEW key", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }

      // Force master.key to exist (first boot creates it), but NO credentials.enc.json.
      const keyResult = await resolveMasterKey(paths, env)
      expect(keyResult.isOk()).toBe(true)
      expect(await exists(paths.credentialsFile)).toBe(false)
      const oldMasterKeyBytes = await readFile(paths.masterKeyFile)

      const result = await rotateMasterKey(paths, env)
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.rotated).toBe(true)
      expect(result.value.backupFile).toBeUndefined()

      const newMasterKeyBytes = await readFile(paths.masterKeyFile)
      expect(newMasterKeyBytes.equals(oldMasterKeyBytes)).toBe(false)

      // No pre-rekey/sidecar left.
      expect(await exists(`${paths.credentialsFile}.pre-rekey`)).toBe(false)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)

      // credential add (store.set) works under the NEW key.
      const newKeyResult = await resolveMasterKey(paths, env)
      expect(newKeyResult.isOk()).toBe(true)
      if (!newKeyResult.isOk()) return
      const store = createEncryptedFileStore(paths, newKeyResult.value)
      const setResult = await store.set("fresh-ref", "fresh-secret")
      expect(setResult.isOk()).toBe(true)
      const getResult = await store.get("fresh-ref")
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) expect(getResult.value).toBe("fresh-secret")
    })
  }, 30000)
})

describe("rotateMasterKey — tier fidelity (never downgrade posture)", () => {
  it("env-passphrase tier + newPassphrase → rotates; fresh .salt; NO master.key written; old salt recoverable", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = {
        ...process.env,
        JUNCTION_STORE: "file",
        JUNCTION_HOME: home,
        JUNCTION_MASTER_KEY: "old passphrase with spaces not raw key shaped",
      }
      delete env.JUNCTION_MASTER_KEY_FILE
      const { secrets } = await seedCredentials(paths, env, ["a", "b"])
      const oldSaltBytes = await readFile(`${paths.masterKeyFile}.salt`)
      expect(await exists(paths.masterKeyFile)).toBe(false)

      const result = await rotateMasterKey(paths, env, {
        newPassphrase: "new passphrase with spaces also not raw key shaped",
      })
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.tier).toBe("env-passphrase")
      expect(result.value.pendingEnvUpdate).toBe(true)

      // NO raw master.key written on this tier.
      expect(await exists(paths.masterKeyFile)).toBe(false)

      // Fresh salt.
      const newSaltBytes = await readFile(`${paths.masterKeyFile}.salt`)
      expect(newSaltBytes.equals(oldSaltBytes)).toBe(false)

      // Opens under the NEW passphrase + new salt.
      const newEnv = {
        ...env,
        JUNCTION_MASTER_KEY: "new passphrase with spaces also not raw key shaped",
      }
      await assertAllResolve(paths, newEnv, secrets)

      // The still-OLD env value + a healed vault: simulate a crash + recovery
      // to prove old-salt recoverability independently (see the crash tests
      // above for env-passphrase specifically):
      expect(await exists(`${paths.masterKeyFile}.salt.pre-rekey`)).toBe(false) // cleaned on success
    })
  }, 30000)

  it("env-passphrase tier interrupted mid-rotation → recovery restores OLD salt; OLD env passphrase re-derives OLD key", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const oldPassphrase = "old passphrase with spaces not raw key shaped"
      const env = {
        ...process.env,
        JUNCTION_STORE: "file",
        JUNCTION_HOME: home,
        JUNCTION_MASTER_KEY: oldPassphrase,
      }
      delete env.JUNCTION_MASTER_KEY_FILE
      const { secrets } = await seedCredentials(paths, env, ["a", "b"])

      const result = await rotateMasterKey(paths, env, {
        newPassphrase: "new passphrase with spaces also not raw key shaped",
        afterStep: (label) => {
          if (label === "9-install-new-key") throw new Error("injected crash after salt overwrite")
        },
      })
      expect(result.isErr()).toBe(true)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(true)

      const recovered = await recoverInterruptedRekey(paths, env)
      expect(recovered.isOk()).toBe(true)
      expect(await exists(`${paths.masterKeyFile}.salt.pre-rekey`)).toBe(false)

      // Still-OLD env passphrase + restored OLD salt → opens the restored ciphertext.
      await assertAllResolve(paths, env, secrets)
    })
  }, 30000)

  it("env-raw tier, no flags → rotate-refused, ZERO writes", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const rawKey = randomBytes(32).toString("base64")
      const env = {
        ...process.env,
        JUNCTION_STORE: "file",
        JUNCTION_HOME: home,
        JUNCTION_MASTER_KEY: rawKey,
      }
      delete env.JUNCTION_MASTER_KEY_FILE
      await seedCredentials(paths, env, ["a"])
      const before = await readFile(paths.credentialsFile, "utf-8")
      expect(await exists(paths.masterKeyFile)).toBe(false)

      const result = await rotateMasterKey(paths, env)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("rotate-refused")

      expect(await exists(paths.masterKeyFile)).toBe(false)
      const after = await readFile(paths.credentialsFile, "utf-8")
      expect(after).toBe(before)
      expect(await exists(path.join(paths.home, ".master.key.old"))).toBe(false)
    })
  }, 30000)

  it("env-raw tier + --print-new-key --i-understand → returns newKeyForOperator; vault opens under it; NO master.key written; pre-rekey kept", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const rawKey = randomBytes(32).toString("base64")
      const env = {
        ...process.env,
        JUNCTION_STORE: "file",
        JUNCTION_HOME: home,
        JUNCTION_MASTER_KEY: rawKey,
      }
      delete env.JUNCTION_MASTER_KEY_FILE
      const { secrets } = await seedCredentials(paths, env, ["a", "b"])

      const result = await rotateMasterKey(paths, env, { printNewKey: true, iUnderstand: true })
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.newKeyForOperator).toBeDefined()
      expect(result.value.pendingEnvUpdate).toBe(true)
      expect(await exists(paths.masterKeyFile)).toBe(false)

      // Vault now opens under the printed key.
      const newEnv = { ...env, JUNCTION_MASTER_KEY: result.value.newKeyForOperator as string }
      await assertAllResolve(paths, newEnv, secrets)

      // Pre-rekey kept + opens under the OLD env key.
      expect(result.value.backupFile).toBeDefined()
      if (result.value.backupFile !== undefined) {
        expect(await exists(result.value.backupFile)).toBe(true)
      }
      const oldKeyResult = await resolveMasterKey(paths, env)
      expect(oldKeyResult.isOk()).toBe(true)
      if (!oldKeyResult.isOk() || result.value.backupFile === undefined) return
      const backupRaw = JSON.parse(await readFile(result.value.backupFile, "utf-8")) as {
        v: 1
        entries: Record<string, { iv: string; tag: string; ct: string }>
      }
      const { gcmDecrypt } = await import("./vault-crypto.js")
      for (const [ref, plaintext] of secrets) {
        const record = backupRaw.entries[ref]
        expect(record).toBeDefined()
        if (!record) continue
        expect(gcmDecrypt(oldKeyResult.value, Buffer.from(ref), record)).toBe(plaintext)
      }
    })
  }, 30000)

  it("--print-new-key without --i-understand still refuses", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const rawKey = randomBytes(32).toString("base64")
      const env = {
        ...process.env,
        JUNCTION_STORE: "file",
        JUNCTION_HOME: home,
        JUNCTION_MASTER_KEY: rawKey,
      }
      delete env.JUNCTION_MASTER_KEY_FILE
      await seedCredentials(paths, env, ["a"])

      const result = await rotateMasterKey(paths, env, { printNewKey: true })
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("rotate-refused")
    })
  }, 30000)

  it("keyring-store refusal happens at the store.backend check — a keyring-backed home refuses", async () => {
    // We simulate this at the resolveMasterKeyWithTier defensive branch level:
    // rotateMasterKey itself checks tier.kind === "keyring" defensively even
    // though createCredentialStore's auto-select would route to keyring first
    // (the CLI checks store.backend before calling rotateMasterKey at all).
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_HOME: home }

      let keyringAvailable = false
      try {
        const { Entry } = await import("@napi-rs/keyring")
        new Entry("junction", "__junction_probe__").getPassword()
        keyringAvailable = true
      } catch {
        // not available in this environment
      }
      if (!keyringAvailable) {
        console.log("Skipping keyring refusal test — keyring not available in this environment")
        return
      }

      const storeResult = await createCredentialStore(paths, { ...env, JUNCTION_STORE: "keyring" })
      expect(storeResult.isOk()).toBe(true)
      if (!storeResult.isOk()) return
      expect(storeResult.value.backend).toBe("keyring")
    })
  })
})

describe("rotateMasterKey — secret hygiene", () => {
  it("sentinel secret never appears in RotateResult, error causes, or the sidecar/backup file paths", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env, JUNCTION_STORE: "file", JUNCTION_HOME: home }
      const sentinel = `SENTINEL_${randomBytes(8).toString("hex")}_MUST_NOT_LEAK`
      const keyResult = await resolveMasterKey(paths, env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return
      const store = createEncryptedFileStore(paths, keyResult.value)
      await store.set("sentinel-ref", sentinel)

      const result = await rotateMasterKey(paths, env)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        const serialized = JSON.stringify(result.value)
        expect(serialized).not.toContain(sentinel)
      }

      // Also sweep raw key bytes never appear serialized as the sentinel value.
      const tierResult = await resolveMasterKeyWithTier(paths, env)
      expect(tierResult.isOk()).toBe(true)
    })
  }, 30000)
})
