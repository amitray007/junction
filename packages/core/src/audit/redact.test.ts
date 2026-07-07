// SPDX-License-Identifier: AGPL-3.0-only
// argKeys / hashArgs — no-values-ever tests (increment 31 A4).

import { describe, expect, it } from "vitest"
import { argKeys, hashArgs } from "./redact.js"

describe("argKeys", () => {
  it("returns sorted key names", () => {
    expect(argKeys({ zebra: 1, apple: 2, mango: 3 })).toEqual(["apple", "mango", "zebra"])
  })

  it("returns an empty array for empty args", () => {
    expect(argKeys({})).toEqual([])
  })

  it("never returns a value — only strings that are the object's own keys", () => {
    const args = { secretToken: "sk-super-secret-value-xyz" }
    const result = argKeys(args)
    expect(result).toEqual(["secretToken"])
    // The returned array must not contain the value anywhere.
    expect(JSON.stringify(result)).not.toContain("sk-super-secret-value-xyz")
  })
})

describe("hashArgs", () => {
  it("same args (same keys + values) produce the same hash", () => {
    const a = hashArgs({ owner: "octo", repo: "hello-world" })
    const b = hashArgs({ owner: "octo", repo: "hello-world" })
    expect(a).toBe(b)
  })

  it("key order does not affect the hash (stable serialization)", () => {
    const a = hashArgs({ owner: "octo", repo: "hello-world" })
    const b = hashArgs({ repo: "hello-world", owner: "octo" })
    expect(a).toBe(b)
  })

  it("different values produce a different hash", () => {
    const a = hashArgs({ owner: "octo" })
    const b = hashArgs({ owner: "someone-else" })
    expect(a).not.toBe(b)
  })

  it("different keys produce a different hash", () => {
    const a = hashArgs({ owner: "octo" })
    const b = hashArgs({ user: "octo" })
    expect(a).not.toBe(b)
  })

  it("empty args produce a stable sentinel hash", () => {
    const a = hashArgs({})
    const b = hashArgs({})
    expect(a).toBe(b)
    expect(typeof a).toBe("string")
    expect(a.length).toBeGreaterThan(0)
  })

  it("is a hex string (sha256 hex is 64 chars)", () => {
    const hash = hashArgs({ a: 1 })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("never returns a value — the hash never contains the raw value as a substring", () => {
    const secretValue = "sk-super-secret-value-xyz-9876"
    const hash = hashArgs({ token: secretValue })
    expect(hash).not.toContain(secretValue)
  })
})
