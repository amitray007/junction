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
