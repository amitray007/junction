// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ensureHome, getPaths } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"
import { createEncryptedFileStore } from "./encrypted-file-store.js"
import { createCredentialStore } from "./index.js"
import { resolveMasterKey } from "./master-key.js"

// Helper: read a file's octal permission bits (masked to low 9 bits).
async function fileMode(p: string): Promise<number> {
  return (await stat(p)).mode & 0o777
}

// Walk a directory tree and return all file contents as Buffers
async function walkFiles(dir: string): Promise<{ path: string; content: Buffer }[]> {
  const { readdir } = await import("node:fs/promises")
  const results: { path: string; content: Buffer }[] = []
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (entry.isFile()) {
      const fullPath = path.join(entry.parentPath ?? dir, entry.name)
      const content = await readFile(fullPath)
      results.push({ path: fullPath, content })
    }
  }
  return results
}

// ---- EncryptedFileStore tests (always use JUNCTION_STORE=file) ----

describe("EncryptedFileStore", () => {
  let restoreEnv: (() => void) | undefined

  beforeEach(() => {
    const prev = process.env.JUNCTION_STORE
    process.env.JUNCTION_STORE = "file"
    restoreEnv = () => {
      if (prev === undefined) delete process.env.JUNCTION_STORE
      else process.env.JUNCTION_STORE = prev
    }
  })

  afterEach(() => {
    restoreEnv?.()
  })

  it("round-trip: set then get returns the same value", async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      const ref = `test-ref-${randomBytes(4).toString("hex")}`
      const secret = "my-super-secret-value"

      const setResult = await store.set(ref, secret)
      expect(setResult.isOk()).toBe(true)

      const getResult = await store.get(ref)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) {
        expect(getResult.value).toBe(secret)
      }
    })
  })

  it("plaintext-never-on-disk: raw bytes of credentials.enc.json do not contain the secret", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      const ref = `test-ref-${randomBytes(4).toString("hex")}`
      const secret = "SUPER_SECRET_VALUE_xyz_plaintext_check"

      const setResult = await store.set(ref, secret)
      expect(setResult.isOk()).toBe(true)

      // (a) credentials.enc.json does not contain the secret
      const raw = await readFile(paths.credentialsFile, "utf-8")
      expect(raw).not.toContain(secret)

      // Check the on-disk record has the expected shape
      const parsed = JSON.parse(raw) as unknown
      expect(parsed).toHaveProperty("v", 1)
      expect(parsed).toHaveProperty("entries")

      // (b) Whole-home scan: no file under JUNCTION_HOME contains the plaintext
      const files = await walkFiles(home)
      for (const { path: filePath, content } of files) {
        const text = content.toString("utf-8")
        expect(text, `Secret found in file: ${filePath}`).not.toContain(secret)
      }
    })
  })

  it("tamper: flipping a byte of ct causes decrypt-failed, never plaintext", async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      const ref = `tamper-ref-${randomBytes(4).toString("hex")}`
      const secret = "tamper-test-secret"

      await store.set(ref, secret)

      // Tamper: flip one byte of ct in the stored record
      const raw = await readFile(paths.credentialsFile, "utf-8")
      const data = JSON.parse(raw) as {
        v: number
        entries: Record<string, { iv: string; tag: string; ct: string }>
      }
      const entry = data.entries[ref]
      expect(entry).toBeDefined()
      if (!entry) return
      const ctBytes = Buffer.from(entry.ct, "base64")
      ctBytes[0] ^= 0xff
      entry.ct = ctBytes.toString("base64")
      await writeFile(paths.credentialsFile, JSON.stringify(data), "utf-8")

      // get() must return decrypt-failed, never plaintext
      const getResult = await store.get(ref)
      expect(getResult.isErr()).toBe(true)
      if (getResult.isErr()) {
        expect(getResult.error.kind).toBe("decrypt-failed")
      }
    })
  })

  it("tamper: flipping a byte of tag causes decrypt-failed", async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      const ref = `tamper-tag-ref-${randomBytes(4).toString("hex")}`
      const secret = "tamper-tag-test-secret"

      await store.set(ref, secret)

      const raw = await readFile(paths.credentialsFile, "utf-8")
      const data = JSON.parse(raw) as {
        v: number
        entries: Record<string, { iv: string; tag: string; ct: string }>
      }
      const entry = data.entries[ref]
      expect(entry).toBeDefined()
      if (!entry) return
      const tagBytes = Buffer.from(entry.tag, "base64")
      tagBytes[0] ^= 0xff
      entry.tag = tagBytes.toString("base64")
      await writeFile(paths.credentialsFile, JSON.stringify(data), "utf-8")

      const getResult = await store.get(ref)
      expect(getResult.isErr()).toBe(true)
      if (getResult.isErr()) {
        expect(getResult.error.kind).toBe("decrypt-failed")
      }
    })
  })

  it("missing ref returns ok(null)", async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      const result = await store.get("nonexistent-ref-xyz")
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toBeNull()
      }
    })
  })

  it("delete is idempotent: deleting absent ref returns ok", async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      const result = await store.delete("nonexistent-ref-for-delete")
      expect(result.isOk()).toBe(true)
    })
  })

  it("delete removes the entry and get returns null", async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      const ref = `delete-ref-${randomBytes(4).toString("hex")}`
      await store.set(ref, "to-be-deleted")
      await store.delete(ref)

      const result = await store.get(ref)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toBeNull()
      }
    })
  })

  it("perms: credentials.enc.json is 0600 and home is 0700", async () => {
    if (process.platform === "win32") return

    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      await store.set("perm-ref", "perm-secret")

      const credStat = await stat(paths.credentialsFile)
      expect(credStat.mode & 0o777).toBe(0o600)

      const homeStat = await stat(paths.home)
      expect(homeStat.mode & 0o777).toBe(0o700)
    })
  })

  it("perms: master.key is 0600", async () => {
    if (process.platform === "win32") return

    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      // resolving master key creates master.key if it doesn't exist
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)

      const keyStat = await stat(paths.masterKeyFile)
      expect(keyStat.mode & 0o777).toBe(0o600)
    })
  })
})

// ---- Master-key scrypt path (exercises real params including maxmem) ----

describe("resolveMasterKey scrypt path", () => {
  it("derives a 32-byte key from a passphrase using real scrypt params", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      const keyResult = await resolveMasterKey(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: "this-is-a-passphrase-not-base64-or-hex-padded",
        JUNCTION_HOME: home,
      })
      expect(keyResult.isOk()).toBe(true)
      if (keyResult.isOk()) {
        expect(keyResult.value).toBeInstanceOf(Buffer)
        expect(keyResult.value.length).toBe(32)
      }
    })
  }, 30000) // scrypt at N=131072 takes ~300ms; allow up to 30s in slow CI

  it("passphrase derives the SAME key across two resolutions (salt persisted)", async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()
      const env = {
        ...process.env,
        JUNCTION_MASTER_KEY: "a-stable-passphrase-for-restart-determinism",
        JUNCTION_HOME: home,
      }
      const first = await resolveMasterKey(paths, env)
      const second = await resolveMasterKey(paths, env)
      expect(first.isOk() && second.isOk()).toBe(true)
      if (first.isOk() && second.isOk()) {
        // Stable salt ⇒ identical derived key ⇒ ciphertext survives a restart.
        expect(first.value.equals(second.value)).toBe(true)
      }
    })
  }, 30000)
})

// ---- createCredentialStore backend selection ----

describe("createCredentialStore", () => {
  it("JUNCTION_STORE=file always returns encrypted-file backend", async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const result = await createCredentialStore(paths, { ...process.env, JUNCTION_STORE: "file" })
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.backend).toBe("encrypted-file")
      }
    })
  })

  it("auto selection returns a valid store", async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const env = { ...process.env }
      delete env.JUNCTION_STORE
      const result = await createCredentialStore(paths, env)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(["keyring", "encrypted-file"]).toContain(result.value.backend)
      }
    })
  })
})

// ---- Security hardening tests ----

describe("EncryptedFileStore security", () => {
  let restoreEnv: (() => void) | undefined

  beforeEach(() => {
    const prev = process.env.JUNCTION_STORE
    process.env.JUNCTION_STORE = "file"
    restoreEnv = () => {
      if (prev === undefined) delete process.env.JUNCTION_STORE
      else process.env.JUNCTION_STORE = prev
    }
  })

  afterEach(() => {
    restoreEnv?.()
  })

  it("AAD-swap resistance: ciphertext from ref-A cannot be substituted into ref-B slot", async () => {
    // Proves cross-handle ciphertext substitution is rejected by GCM auth-tag (AAD mismatch).
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      const refA = `aad-ref-a-${randomBytes(4).toString("hex")}`
      const refB = `aad-ref-b-${randomBytes(4).toString("hex")}`
      const secret = "aad-swap-secret"

      // Write refA
      const setResult = await store.set(refA, secret)
      expect(setResult.isOk()).toBe(true)

      // Read enc file, copy refA's {iv,tag,ct} into refB slot
      const raw = await readFile(paths.credentialsFile, "utf-8")
      const data = JSON.parse(raw) as {
        v: number
        entries: Record<string, { iv: string; tag: string; ct: string }>
      }
      const entryA = data.entries[refA]
      expect(entryA).toBeDefined()
      if (!entryA) return
      // Substitute refA ciphertext into refB slot (different AAD on decrypt will fail)
      data.entries[refB] = { ...entryA }
      await writeFile(paths.credentialsFile, JSON.stringify(data), "utf-8")

      // get(refB) MUST return decrypt-failed — the AAD mismatch causes GCM final() to throw
      const getResult = await store.get(refB)
      expect(getResult.isErr()).toBe(true)
      if (getResult.isErr()) {
        expect(getResult.error.kind).toBe("decrypt-failed")
      }
    })
  })

  it("corrupt-but-present file: get/set returns io-failed and does NOT overwrite", async () => {
    // FIX 2: a one-byte-mangled credentials.enc.json must block all operations, not be silently
    // treated as empty (which would let the next set() permanently destroy prior ciphertext).
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      // Write a non-empty but mangled JSON to credentials.enc.json
      const corruptContent = '{"v":1,"entries":{"ref1":{MANGLED}}}'
      await writeFile(paths.credentialsFile, corruptContent, "utf-8")

      const store = createEncryptedFileStore(paths, keyResult.value)

      // get() must return io-failed
      const getResult = await store.get("any-ref")
      expect(getResult.isErr()).toBe(true)
      if (getResult.isErr()) {
        expect(getResult.error.kind).toBe("io-failed")
      }

      // set() must also return io-failed (must NOT overwrite the corrupt file)
      const setResult = await store.set("any-ref", "some-secret")
      expect(setResult.isErr()).toBe(true)
      if (setResult.isErr()) {
        expect(setResult.error.kind).toBe("io-failed")
      }

      // Assert: the corrupt file was NOT overwritten or emptied
      const afterContent = await readFile(paths.credentialsFile, "utf-8")
      expect(afterContent).toBe(corruptContent)
    })
  })

  it("ENOENT (missing file) → ok(null) for get, ok for set (normal first-run)", async () => {
    // Verify ENOENT still works as the normal 'no credentials yet' case (not broken by FIX 2).
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)

      // File doesn't exist yet — get should return ok(null)
      const getResult = await store.get("nonexistent-ref")
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) {
        expect(getResult.value).toBeNull()
      }

      // set should create the file and succeed
      const ref = `new-ref-${randomBytes(4).toString("hex")}`
      const setResult = await store.set(ref, "new-secret")
      expect(setResult.isOk()).toBe(true)

      // File now exists and is readable
      const getAfter = await store.get(ref)
      expect(getAfter.isOk()).toBe(true)
      if (getAfter.isOk()) {
        expect(getAfter.value).toBe("new-secret")
      }
    })
  })

  it("salt-file perms: master.key.salt is 0600 on POSIX after passphrase resolution", async () => {
    if (process.platform === "win32") return

    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      // Passphrase that is NOT raw-key-shaped → triggers scrypt → creates salt file
      const keyResult = await resolveMasterKey(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: "a-genuine-passphrase-not-hex-or-base64",
        JUNCTION_HOME: home,
      })
      expect(keyResult.isOk()).toBe(true)

      const saltFile = `${paths.masterKeyFile}.salt`
      const saltMode = await fileMode(saltFile)
      expect(saltMode).toBe(0o600)
    })
  }, 30000)

  it("error-cause-no-plaintext: decrypt-failed error does not contain the secret or key bytes", async () => {
    // Regression guard: even if error serialization changes, known secret must never appear.
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()
      const keyResult = await resolveMasterKey(paths, process.env)
      expect(keyResult.isOk()).toBe(true)
      if (!keyResult.isOk()) return

      const store = createEncryptedFileStore(paths, keyResult.value)
      const ref = `error-cause-ref-${randomBytes(4).toString("hex")}`
      const knownSecret = "KNOWN_SECRET_MUST_NOT_APPEAR_IN_ERROR"

      await store.set(ref, knownSecret)

      // Tamper the ciphertext to force decrypt-failed
      const raw = await readFile(paths.credentialsFile, "utf-8")
      const data = JSON.parse(raw) as {
        v: number
        entries: Record<string, { iv: string; tag: string; ct: string }>
      }
      const entry = data.entries[ref]
      expect(entry).toBeDefined()
      if (!entry) return
      const ctBytes = Buffer.from(entry.ct, "base64")
      ctBytes[0] ^= 0xff
      entry.ct = ctBytes.toString("base64")
      await writeFile(paths.credentialsFile, JSON.stringify(data), "utf-8")

      const getResult = await store.get(ref)
      expect(getResult.isErr()).toBe(true)
      if (getResult.isErr()) {
        expect(getResult.error.kind).toBe("decrypt-failed")
        // Serialize the error object and assert no secret literal appears
        const serialized = JSON.stringify(getResult.error)
        expect(serialized).not.toContain(knownSecret)
        // Also assert raw key bytes don't appear (key is 32 random bytes — check hex encoding)
        const keyHex = keyResult.value.toString("hex")
        expect(serialized).not.toContain(keyHex)
      }
    })
  })
})

// ---- Master-key env near-miss + oversized key tests (FIX 3) ----

describe("resolveMasterKey env near-miss (FIX 3)", () => {
  it("valid 32-byte base64-encoded key (44 chars with =) is accepted as raw key", async () => {
    // Baseline: a legitimate 32-byte key base64-encoded resolves to the raw key, not scrypt.
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      const rawKey = randomBytes(32)
      const b64Key = rawKey.toString("base64") // 44 chars ending in '='
      expect(b64Key.length).toBe(44)

      const keyResult = await resolveMasterKey(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: b64Key,
        JUNCTION_HOME: home,
      })
      expect(keyResult.isOk()).toBe(true)
      if (keyResult.isOk()) {
        expect(keyResult.value.equals(rawKey)).toBe(true)
      }
    })
  })

  it("valid 32-byte hex-encoded key (64 chars) is accepted as raw key", async () => {
    // Baseline: a legitimate 32-byte key hex-encoded resolves to the raw key, not scrypt.
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      const rawKey = randomBytes(32)
      const hexKey = rawKey.toString("hex") // 64 chars
      expect(hexKey.length).toBe(64)

      const keyResult = await resolveMasterKey(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: hexKey,
        JUNCTION_HOME: home,
      })
      expect(keyResult.isOk()).toBe(true)
      if (keyResult.isOk()) {
        expect(keyResult.value.equals(rawKey)).toBe(true)
      }
    })
  })

  it("43-char base64 string (no padding) is accepted as raw key — 43 base64 chars always = 32 bytes", async () => {
    // 32 bytes encodes to 44-char base64 with '='. Stripping the '=' gives 43 chars.
    // Node.js Buffer.from() is lenient and decodes 43 chars to 32 bytes (treats as unpadded).
    // The shape regex matches 43 chars (no '=') → this IS a valid raw-key shape.
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      const rawKey = randomBytes(32)
      const b64Nopad = rawKey.toString("base64").replace(/=+$/, "") // strip trailing '='
      expect(b64Nopad.length).toBe(43)

      const keyResult = await resolveMasterKey(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: b64Nopad,
        JUNCTION_HOME: home,
      })
      expect(keyResult.isOk()).toBe(true)
      if (keyResult.isOk()) {
        expect(keyResult.value.equals(rawKey)).toBe(true)
      }
    })
  })

  it("65-char hex string does NOT match raw-key shape (not 64 chars) → treated as passphrase", async () => {
    // FIX 3 guard: a 65-char hex value doesn't match the 64-char hex shape, so it falls
    // to scrypt (passphrase path). The result is a valid 32-byte key, NOT a raw-hex decode.
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      const sixtyFiveHex = `${randomBytes(32).toString("hex")}a` // 65 chars
      expect(sixtyFiveHex.length).toBe(65)

      const keyResult = await resolveMasterKey(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: sixtyFiveHex,
        JUNCTION_HOME: home,
      })
      // Does NOT match raw-key shape → scrypt → ok (32-byte derived key, NOT the first 32 hex bytes)
      expect(keyResult.isOk()).toBe(true)
      if (keyResult.isOk()) {
        expect(keyResult.value.length).toBe(32)
        // Sanity: derived key ≠ first 32 bytes of the hex-decoded input (proves it went through scrypt)
        const rawHexBytes = Buffer.from(sixtyFiveHex.slice(0, 64), "hex")
        expect(keyResult.value.equals(rawHexBytes)).toBe(false)
      }
    })
  }, 30000) // scrypt

  it("genuine passphrase (non-raw-key-shaped) still derives key via scrypt", async () => {
    // Confirm the genuine-passphrase path is unaffected by FIX 3.
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      // A passphrase with spaces — definitely not base64/hex shaped
      const keyResult = await resolveMasterKey(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: "this is a plain passphrase with spaces",
        JUNCTION_HOME: home,
      })
      expect(keyResult.isOk()).toBe(true)
      if (keyResult.isOk()) {
        expect(keyResult.value).toBeInstanceOf(Buffer)
        expect(keyResult.value.length).toBe(32)
      }
    })
  }, 30000)

  it("oversized key (100-char hex) does not match raw-key shape → treated as passphrase, not truncated", async () => {
    // FIX 3: a 100-char hex value does NOT match the 64-char hex shape regex.
    // It falls to the passphrase/scrypt path — it is NOT silently truncated to 32 bytes.
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      const hundredHex = randomBytes(50).toString("hex") // 100 chars
      expect(hundredHex.length).toBe(100)

      const keyResult = await resolveMasterKey(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: hundredHex,
        JUNCTION_HOME: home,
      })
      // Does NOT match raw-key shape → scrypt passphrase → 32-byte derived key
      expect(keyResult.isOk()).toBe(true)
      if (keyResult.isOk()) {
        expect(keyResult.value.length).toBe(32)
        // Derived key ≠ the first 32 bytes of the hex value (proves it's not a truncated raw-decode)
        const inputBytes = Buffer.from(hundredHex.slice(0, 64), "hex")
        expect(keyResult.value.equals(inputBytes)).toBe(false)
      }
    })
  }, 30000)
})

// ---- KeyringStore (gated on keyring availability) ----

describe("KeyringStore", () => {
  it("round-trip via keyring (skipped when keyring unavailable)", async () => {
    // Check keyring availability first
    let keyringAvailable = false
    try {
      const { Entry } = await import("@napi-rs/keyring")
      new Entry("junction", "__junction_probe__").getPassword()
      keyringAvailable = true
    } catch {
      // not available
    }

    if (!keyringAvailable) {
      console.log("Skipping keyring test — keyring not available in this environment")
      return
    }

    const { createKeyringStore } = await import("./keyring-store.js")
    const store = createKeyringStore()
    const ref = `junction-test-keyring-${randomBytes(4).toString("hex")}`
    const secret = "keyring-round-trip-secret"

    try {
      const setResult = await store.set(ref, secret)
      expect(setResult.isOk()).toBe(true)

      const getResult = await store.get(ref)
      expect(getResult.isOk()).toBe(true)
      if (getResult.isOk()) {
        expect(getResult.value).toBe(secret)
      }

      // Delete and verify gone
      const delResult = await store.delete(ref)
      expect(delResult.isOk()).toBe(true)

      const afterDel = await store.get(ref)
      expect(afterDel.isOk()).toBe(true)
      if (afterDel.isOk()) {
        expect(afterDel.value).toBeNull()
      }
    } finally {
      // Teardown: ensure cleanup even if test fails. ResultAsync is a Promise subclass;
      // use .then(noop, noop) to swallow errors rather than .catch (which isn't a method).
      await store.delete(ref).then(
        () => {},
        () => {},
      )
    }
  })
})
