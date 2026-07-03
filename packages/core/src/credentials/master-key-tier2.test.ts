// SPDX-License-Identifier: AGPL-3.0-only
// resolveMasterKey Tier-2 (OS keyring) branch tests — increment 28.95 GAP-1.
//
// Mocks @napi-rs/keyring so the Tier-2 branch is deterministic (no dependency
// on the real OS keyring being present/absent in CI). Kept in a SEPARATE file
// from credentials.test.ts: vi.mock("@napi-rs/keyring") is file-scoped and
// hoisted, and credentials.test.ts's "KeyringStore" describe block exercises
// the REAL keyring (skipping itself when unavailable) — mixing the two in one
// file would make that real-keyring test see the mock instead.
//
// THE INVARIANT UNDER TEST (master-key.ts "FIX 4", ~lines 214-231): a
// present-but-malformed Tier-2 keyring value (decodes to ≠32 bytes) MUST
// return Err({kind:"key-unavailable"}) and must NOT silently fall through to
// Tier-3 (auto-generated file key) — silent fallthrough would derive a
// DIFFERENT key on a future boot while prior ciphertext was (or would be)
// encrypted under the Tier-2 key, bricking previously-stored secrets.

import { stat } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensureHome, getPaths } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"

// ---------------------------------------------------------------------------
// Mock @napi-rs/keyring — a controllable Entry.getPassword()
// ---------------------------------------------------------------------------

let mockGetPassword: () => string | null = () => null

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(
      public service: string,
      public account: string,
    ) {}
    getPassword(): string | null {
      return mockGetPassword()
    }
  },
}))

const { resolveMasterKey } = await import("./master-key.js")

/** Env with Tier-1 (JUNCTION_MASTER_KEY / _FILE) explicitly unset, so Tier-2 is reached. */
function tier2Env(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.JUNCTION_MASTER_KEY
  delete env.JUNCTION_MASTER_KEY_FILE
  return env
}

describe("resolveMasterKey — Tier 2 (OS keyring)", () => {
  beforeEach(() => {
    mockGetPassword = () => null
  })

  afterEach(() => {
    mockGetPassword = () => null
  })

  it("malformed keyring key (decodes to ≠32 bytes) → Err key-unavailable, and does NOT create the auto-gen master.key file (no Tier-3 fallthrough)", async () => {
    // 16 bytes base64-encoded — matches neither the 43/44-char base64-32-byte
    // shape nor the 64-char hex shape checked by tryDecodeKey (that check only
    // applies to Tier 1); Tier 2 decodes raw base64 directly and checks length.
    const malformed = Buffer.alloc(16, 0xab).toString("base64")
    mockGetPassword = () => malformed

    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()

      const result = await resolveMasterKey(paths, tier2Env())
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("key-unavailable")
      }

      // Prove no silent Tier-3 fallthrough: the auto-gen file must NOT exist.
      await expect(stat(paths.masterKeyFile)).rejects.toThrow()
    })
  })

  it("valid 32-byte keyring key → Ok, returns those exact 32 bytes (happy Tier-2 path)", async () => {
    const rawKey = Buffer.alloc(32, 0x42)
    mockGetPassword = () => rawKey.toString("base64")

    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()

      const result = await resolveMasterKey(paths, tier2Env())
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.length).toBe(32)
        expect(result.value.equals(rawKey)).toBe(true)
      }

      // Tier 2 succeeded — Tier 3 must not have run, so no auto-gen file either.
      await expect(stat(paths.masterKeyFile)).rejects.toThrow()
    })
  })

  it("absent keyring entry (getPassword → null) with no env → falls through to Tier 3 auto-gen (Ok, 32 bytes, file created 0600)", async () => {
    mockGetPassword = () => null

    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()

      const result = await resolveMasterKey(paths, tier2Env())
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.length).toBe(32)
      }

      if (process.platform !== "win32") {
        const fileStat = await stat(paths.masterKeyFile)
        expect(fileStat.mode & 0o777).toBe(0o600)
      }
    })
  })
})
