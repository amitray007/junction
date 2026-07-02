// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for keys-mutations.server.ts helpers.
// Covers: metadata-only readApiKeys, mint (incl. the plaintext-once shape),
// revoke (incl. idempotency), and countKeysReferencingProfile — against a real
// temp DB (same pattern as profile-mutations.server.test.ts).
//
// SECURITY (§3 of docs/methods/27-junction-keys-single-endpoint.md): the loader
// (readApiKeys) must NEVER surface secretHash or plaintext — asserted via a
// JSON-stringify negative test, not just field-by-field checks (catches an
// accidental future field addition too).

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRepositories,
  getDatabase,
  getPaths,
  newProfileId,
  ProfileNameSchema,
} from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  countKeysReferencingProfile,
  mutateMintKey,
  mutateRevokeKey,
  readApiKeys,
} from "./keys-mutations.server.js"

async function makeRepos(home: string) {
  const prevHome = process.env.JUNCTION_HOME
  process.env.JUNCTION_HOME = home
  const dbResult = await getDatabase(getPaths())
  if (dbResult.isErr()) throw new Error(String(dbResult.error))
  if (prevHome === undefined) delete process.env.JUNCTION_HOME
  else process.env.JUNCTION_HOME = prevHome
  return createRepositories(dbResult.value)
}

describe("keys-mutations.server", () => {
  let tmpHome: string
  let prevHome: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "junction-km-test-"))
    prevHome = process.env.JUNCTION_HOME
    process.env.JUNCTION_HOME = tmpHome
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    await rm(tmpHome, { recursive: true, force: true })
  })

  async function seedProfile(name: string): Promise<string> {
    const repos = await makeRepos(tmpHome)
    const id = newProfileId()
    const parsed = ProfileNameSchema.parse(name)
    const result = await repos.profiles.create({ id, name: parsed, sources: [] })
    if (result.isErr()) throw new Error(String(result.error))
    return String(id)
  }

  // ---------------------------------------------------------------------------
  // mutateMintKey
  // ---------------------------------------------------------------------------

  describe("mutateMintKey", () => {
    it("mints a global key with zero profiles", async () => {
      process.env.JUNCTION_HOME = tmpHome
      const result = await mutateMintKey({ label: "global-key", scope: "global", profileIds: [] })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected success")
      expect(result.plaintext).toMatch(/^jct_[0-9A-HJKMNP-TV-Z]{26}_.+$/)
      expect(result.meta.scope).toBe("global")
      expect(result.meta.profileIds).toEqual([])
    })

    it("mints a profile-scoped key referencing one profile", async () => {
      const profileId = await seedProfile("work")
      process.env.JUNCTION_HOME = tmpHome
      const result = await mutateMintKey({
        label: "work-key",
        scope: "profile",
        profileIds: [profileId],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected success")
      expect(result.meta.scope).toBe("profile")
      expect(result.meta.profileIds).toEqual([profileId])
    })

    it("rejects an empty label", async () => {
      process.env.JUNCTION_HOME = tmpHome
      const result = await mutateMintKey({ label: "", scope: "global", profileIds: [] })
      expect(result.ok).toBe(false)
    })

    it("the plaintext is never persisted in the DB row (only the hash is)", async () => {
      process.env.JUNCTION_HOME = tmpHome
      const mintResult = await mutateMintKey({ label: "no-leak", scope: "global", profileIds: [] })
      expect(mintResult.ok).toBe(true)
      if (!mintResult.ok) throw new Error("expected success")

      const repos = await makeRepos(tmpHome)
      const listResult = await repos.apiKeys.list()
      expect(listResult.isOk()).toBe(true)
      if (!listResult.isOk()) throw new Error("expected list success")
      const row = listResult.value.find((r) => r.id === mintResult.meta.id)
      expect(row).toBeDefined()
      // The stored row must never contain the plaintext secret or the full token.
      expect(JSON.stringify(row)).not.toContain(mintResult.plaintext)
    })
  })

  // ---------------------------------------------------------------------------
  // readApiKeys — metadata-only (negative test)
  // ---------------------------------------------------------------------------

  describe("readApiKeys", () => {
    it("returns an empty list when no keys exist", async () => {
      process.env.JUNCTION_HOME = tmpHome
      const rows = await readApiKeys()
      expect(rows).toEqual([])
    })

    it("returns metadata for minted keys, with scope profileIds resolved", async () => {
      const profileId = await seedProfile("work")
      process.env.JUNCTION_HOME = tmpHome
      const mintResult = await mutateMintKey({
        label: "work-key",
        scope: "profile",
        profileIds: [profileId],
      })
      expect(mintResult.ok).toBe(true)

      const rows = await readApiKeys()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.label).toBe("work-key")
      expect(rows[0]?.profileIds).toEqual([profileId])
    })

    it("NEGATIVE: the JSON-serialized list never contains secretHash or a jct_ plaintext token", async () => {
      process.env.JUNCTION_HOME = tmpHome
      const mintResult = await mutateMintKey({
        label: "check-leak",
        scope: "global",
        profileIds: [],
      })
      expect(mintResult.ok).toBe(true)

      const rows = await readApiKeys()
      const json = JSON.stringify(rows)
      expect(json).not.toMatch(/secretHash|secret_hash/i)
      // No full jct_<keyid>_<secret> token anywhere in the metadata payload.
      expect(json).not.toMatch(/jct_[0-9A-HJKMNP-TV-Z]{26}_[^"]+/)
    })
  })

  // ---------------------------------------------------------------------------
  // mutateRevokeKey — idempotent
  // ---------------------------------------------------------------------------

  describe("mutateRevokeKey", () => {
    it("revokes an active key", async () => {
      process.env.JUNCTION_HOME = tmpHome
      const mintResult = await mutateMintKey({
        label: "to-revoke",
        scope: "global",
        profileIds: [],
      })
      expect(mintResult.ok).toBe(true)
      if (!mintResult.ok) throw new Error("expected success")

      const revokeResult = await mutateRevokeKey(mintResult.meta.id)
      expect(revokeResult.ok).toBe(true)

      const rows = await readApiKeys()
      const row = rows.find((r) => r.id === mintResult.meta.id)
      expect(row?.revokedAt).not.toBeNull()
    })

    it("revoking an already-revoked key is idempotent (still succeeds)", async () => {
      process.env.JUNCTION_HOME = tmpHome
      const mintResult = await mutateMintKey({
        label: "double-revoke",
        scope: "global",
        profileIds: [],
      })
      expect(mintResult.ok).toBe(true)
      if (!mintResult.ok) throw new Error("expected success")

      const first = await mutateRevokeKey(mintResult.meta.id)
      const second = await mutateRevokeKey(mintResult.meta.id)
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
    })

    it("revoking an unknown keyid fails with not-found", async () => {
      process.env.JUNCTION_HOME = tmpHome
      const result = await mutateRevokeKey("01JX3M8QK9RS2T5V7XZA0BCDE9")
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected failure")
      expect(result.error).toMatch(/not found/i)
    })
  })

  // ---------------------------------------------------------------------------
  // countKeysReferencingProfile — the delete-profile warning
  // ---------------------------------------------------------------------------

  describe("countKeysReferencingProfile", () => {
    it("returns 0 for a profile with no referencing keys", async () => {
      const profileId = await seedProfile("lonely")
      process.env.JUNCTION_HOME = tmpHome
      const count = await countKeysReferencingProfile(profileId)
      expect(count).toBe(0)
    })

    it("counts distinct keys referencing a profile", async () => {
      const profileId = await seedProfile("shared")
      process.env.JUNCTION_HOME = tmpHome
      await mutateMintKey({ label: "k1", scope: "profile", profileIds: [profileId] })
      await mutateMintKey({ label: "k2", scope: "profile", profileIds: [profileId] })

      const count = await countKeysReferencingProfile(profileId)
      expect(count).toBe(2)
    })
  })
})
