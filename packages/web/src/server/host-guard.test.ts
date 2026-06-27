// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest"
import { isLocalHost } from "./host-guard.js"

describe("isLocalHost", () => {
  it("accepts loopback hosts (with and without port, any case)", () => {
    for (const h of [
      "127.0.0.1",
      "127.0.0.1:4321",
      "localhost",
      "localhost:4321",
      "LOCALHOST",
      "[::1]",
      "[::1]:4321",
    ]) {
      expect(isLocalHost(h)).toBe(true)
    }
  })

  it("rejects non-loopback + suffix-bypass + spoofed hosts", () => {
    for (const h of [
      "evil.com",
      "127.0.0.1.evil.com",
      "localhost.evil.com",
      "10.0.0.5",
      "example.com:4321",
      "127.0.0.1@evil.com",
    ]) {
      expect(isLocalHost(h)).toBe(false)
    }
  })

  it("fails closed on missing/empty Host", () => {
    expect(isLocalHost(null)).toBe(false)
    expect(isLocalHost(undefined)).toBe(false)
    expect(isLocalHost("")).toBe(false)
  })
})
