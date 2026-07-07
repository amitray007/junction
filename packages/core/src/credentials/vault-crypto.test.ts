// SPDX-License-Identifier: AGPL-3.0-only
// Tests for the shared vault-crypto primitives (increment 32.2-foundation).

import { randomBytes } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { withTempHome } from "../testing/index.js"
import {
  deriveKeyFromPassphrase,
  type EncRecord,
  gcmDecrypt,
  gcmEncrypt,
  writeFile0600,
} from "./vault-crypto.js"

describe("gcmEncrypt / gcmDecrypt", () => {
  it("round-trips for a given key + aad", () => {
    const key = randomBytes(32)
    const aad = Buffer.from("secret-ref-1")
    const plaintext = "round-trip-plaintext-value"

    const record = gcmEncrypt(key, aad, plaintext)
    const decrypted = gcmDecrypt(key, aad, record)

    expect(decrypted).toBe(plaintext)
  })

  it("uses a fresh IV each call — two encrypts of the same plaintext differ in iv/ct", () => {
    const key = randomBytes(32)
    const aad = Buffer.from("secret-ref-2")
    const plaintext = "same-plaintext-both-times"

    const recordA = gcmEncrypt(key, aad, plaintext)
    const recordB = gcmEncrypt(key, aad, plaintext)

    expect(recordA.iv).not.toBe(recordB.iv)
    expect(recordA.ct).not.toBe(recordB.ct)
  })

  it("AAD binding: a record encrypted with aad=A fails gcmDecrypt(key, B, record)", () => {
    const key = randomBytes(32)
    const aadA = Buffer.from("aad-a")
    const aadB = Buffer.from("aad-b")
    const plaintext = "aad-bound-secret"

    const record = gcmEncrypt(key, aadA, plaintext)

    expect(() => gcmDecrypt(key, aadB, record)).toThrow()
  })

  it("tag tamper: flipping one byte of tag causes gcmDecrypt to throw", () => {
    const key = randomBytes(32)
    const aad = Buffer.from("tamper-tag-ref")
    const record = gcmEncrypt(key, aad, "tamper-tag-plaintext")

    const tagBytes = Buffer.from(record.tag, "base64")
    tagBytes[0] ^= 0xff
    const tampered: EncRecord = { ...record, tag: tagBytes.toString("base64") }

    expect(() => gcmDecrypt(key, aad, tampered)).toThrow()
  })

  it("ct tamper: flipping one byte of ct causes gcmDecrypt to throw", () => {
    const key = randomBytes(32)
    const aad = Buffer.from("tamper-ct-ref")
    const record = gcmEncrypt(key, aad, "tamper-ct-plaintext")

    const ctBytes = Buffer.from(record.ct, "base64")
    ctBytes[0] ^= 0xff
    const tampered: EncRecord = { ...record, ct: ctBytes.toString("base64") }

    expect(() => gcmDecrypt(key, aad, tampered)).toThrow()
  })
})

describe("deriveKeyFromPassphrase", () => {
  it("derives a 32-byte key", async () => {
    const salt = randomBytes(16)
    const result = await deriveKeyFromPassphrase("a-test-passphrase", salt)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBeInstanceOf(Buffer)
      expect(result.value.length).toBe(32)
    }
  }, 30000)

  it("is deterministic for a fixed salt", async () => {
    const salt = randomBytes(16)
    const first = await deriveKeyFromPassphrase("stable-passphrase", salt)
    const second = await deriveKeyFromPassphrase("stable-passphrase", salt)
    expect(first.isOk() && second.isOk()).toBe(true)
    if (first.isOk() && second.isOk()) {
      expect(first.value.equals(second.value)).toBe(true)
    }
  }, 30000)

  it("differs for a different salt", async () => {
    const saltA = randomBytes(16)
    const saltB = randomBytes(16)
    const resultA = await deriveKeyFromPassphrase("same-passphrase", saltA)
    const resultB = await deriveKeyFromPassphrase("same-passphrase", saltB)
    expect(resultA.isOk() && resultB.isOk()).toBe(true)
    if (resultA.isOk() && resultB.isOk()) {
      expect(resultA.value.equals(resultB.value)).toBe(false)
    }
  }, 30000)
})

describe("writeFile0600", () => {
  it("writes a file at mode 0600 with byte-equal content", async () => {
    if (process.platform === "win32") return

    await withTempHome(async (home) => {
      const target = path.join(home, "vault-crypto-write-test.bin")
      const data = randomBytes(64)

      await writeFile0600(target, data)

      const written = await stat(target)
      expect(written.mode & 0o777).toBe(0o600)

      const { readFile } = await import("node:fs/promises")
      const content = await readFile(target)
      expect(content.equals(data)).toBe(true)
    })
  })

  it("overwrites atomically, leaving no .tmp file behind", async () => {
    if (process.platform === "win32") return

    await withTempHome(async (home) => {
      const target = path.join(home, "vault-crypto-overwrite-test.bin")
      await writeFile0600(target, randomBytes(32))
      const second = randomBytes(32)
      await writeFile0600(target, second)

      const { readFile } = await import("node:fs/promises")
      const content = await readFile(target)
      expect(content.equals(second)).toBe(true)

      const entries = await readdir(home)
      const tmpFiles = entries.filter((name) => name.endsWith(".tmp"))
      expect(tmpFiles).toEqual([])
    })
  })
})
