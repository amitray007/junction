// SPDX-License-Identifier: AGPL-3.0-only
// resolveMasterKeyWithTier tests (increment 32.2-foundation).
//
// Mocks @napi-rs/keyring for the Tier-2 (keyring) case — kept in a SEPARATE file from
// credentials.test.ts / master-key-tier2.test.ts for the same reason master-key-tier2.test.ts
// is separate: vi.mock("@napi-rs/keyring") is file-scoped and hoisted, and mixing it with a
// real-keyring test in the same file would make that real-keyring test see the mock instead.

import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensureHome, getPaths } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"

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

const { resolveMasterKey, resolveMasterKeyWithTier } = await import("./master-key.js")

/** Env with Tier-1 (JUNCTION_MASTER_KEY / _FILE) explicitly unset, so Tier-2 is reached. */
function tier2Env(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.JUNCTION_MASTER_KEY
  delete env.JUNCTION_MASTER_KEY_FILE
  return env
}

describe("resolveMasterKeyWithTier", () => {
  beforeEach(() => {
    mockGetPassword = () => null
  })

  afterEach(() => {
    mockGetPassword = () => null
  })

  it('reports { kind: "env-raw" } for a 32B base64 env key', async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      const rawKey = randomBytes(32)
      const result = await resolveMasterKeyWithTier(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: rawKey.toString("base64"),
        JUNCTION_HOME: home,
      })
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.tier).toEqual({ kind: "env-raw" })
        expect(result.value.key.equals(rawKey)).toBe(true)
      }
    })
  })

  it('reports { kind: "env-passphrase" } for a non-raw-shaped env value', async () => {
    await withTempHome(async (home) => {
      await ensureHome()
      const paths = getPaths()

      const result = await resolveMasterKeyWithTier(paths, {
        ...process.env,
        JUNCTION_MASTER_KEY: "this is a genuine passphrase with spaces",
        JUNCTION_HOME: home,
      })
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.tier).toEqual({ kind: "env-passphrase" })
        expect(result.value.key.length).toBe(32)
      }
    }, 30000)
  }, 30000)

  it('reports { kind: "file" } for the Tier-3 auto-gen path', async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()

      const result = await resolveMasterKeyWithTier(paths, tier2Env())
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.tier).toEqual({ kind: "file" })
        expect(result.value.key.length).toBe(32)
      }
    })
  })

  it('reports { kind: "keyring" } for a mocked 32B keyring entry', async () => {
    const rawKey = Buffer.alloc(32, 0x42)
    mockGetPassword = () => rawKey.toString("base64")

    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()

      const result = await resolveMasterKeyWithTier(paths, tier2Env())
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.tier).toEqual({ kind: "keyring" })
        expect(result.value.key.equals(rawKey)).toBe(true)
      }
    })
  })

  it("resolveMasterKey still returns the same key as resolveMasterKeyWithTier(...).key (delegation regression)", async () => {
    await withTempHome(async () => {
      await ensureHome()
      const paths = getPaths()

      const withTier = await resolveMasterKeyWithTier(paths, tier2Env())
      expect(withTier.isOk()).toBe(true)

      const justKey = await resolveMasterKey(paths, tier2Env())
      expect(justKey.isOk()).toBe(true)

      if (withTier.isOk() && justKey.isOk()) {
        // Both calls resolve to the same auto-generated file key (Tier 3, persisted).
        expect(justKey.value.equals(withTier.value.key)).toBe(true)
      }
    })
  })
})
