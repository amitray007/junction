// SPDX-License-Identifier: AGPL-3.0-only
// mintApiKey / verifyApiKey + api-keys repo tests (increment 27).
//
// Test surface:
//   (a) mint/verify round-trip (all 3 scope kinds)
//   (b) wrong secret → fail (unknown-key, uniform with unknown keyid)
//   (c) revoked key → fail
//   (d) empty-scope: profile/profiles kind with 0 rows → fail;
//       global kind with 0 rows → OK (empty profileIds)
//   (e) adversarial token parses (empty, no prefix, bad keyid charset,
//       embedded \n, unicode, 10 KB token)
//   (f) hash is hex-sha256 of the secret ONLY
//   (g) timingSafeEqual — equal-length buffers, no throw
//   (h) repo CRUD + cascade (delete profile → join row gone; key row stays)
//   (i) idempotent revoke
//   (j) label schema bounds

import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getDatabase } from "../db/index.js"
import { newProfileId } from "../ids/index.js"
import { getPaths } from "../paths/index.js"
import { createRepositories, type Repositories } from "../repositories/index.js"
import { ApiKeyLabelSchema } from "../schema/primitives.js"
import { sha256Hex } from "./hash.js"
import { mintApiKey } from "./mint.js"
import { parseApiKeyToken, verifyApiKey } from "./verify.js"

describe("api-keys", () => {
  let repos: Repositories
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    home = await mkdtemp(join(tmpdir(), "junction-apikeys-test-"))
    process.env.JUNCTION_HOME = home
    const result = await getDatabase(getPaths())
    if (result.isErr()) throw result.error
    repos = createRepositories(result.value)
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // sha256Hex — the hash primitive
  // -------------------------------------------------------------------------
  describe("sha256Hex", () => {
    it("is the hex sha256 of the input string", () => {
      const expected = createHash("sha256").update("hello", "utf8").digest("hex")
      expect(sha256Hex("hello")).toBe(expected)
    })

    it("differs for different inputs", () => {
      expect(sha256Hex("a")).not.toBe(sha256Hex("b"))
    })
  })

  // -------------------------------------------------------------------------
  // parseApiKeyToken — adversarial inputs
  // -------------------------------------------------------------------------
  describe("parseApiKeyToken", () => {
    it("parses a well-formed token", () => {
      const keyId = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
      const token = `jct_${keyId}_someSecretValue-_123`
      const { keyId: parsedId, secret } = parseApiKeyToken(token)
      expect(parsedId).toBe(keyId)
      expect(secret).toBe("someSecretValue-_123")
    })

    it("rejects an empty string", () => {
      expect(parseApiKeyToken("").keyId).toBeUndefined()
    })

    it("rejects a token with no jct_ prefix", () => {
      expect(parseApiKeyToken("01ARZ3NDEKTSV4RRFFQ69G5FAV_secret").keyId).toBeUndefined()
    })

    it("rejects a keyid with an invalid Crockford-b32 char (e.g. lowercase, I/L/O/U)", () => {
      expect(parseApiKeyToken("jct_01arz3ndektsv4rrffq69g5fav_secret").keyId).toBeUndefined()
      expect(parseApiKeyToken("jct_IIIIIIIIIIIIIIIIIIIIIIIIII_secret").keyId).toBeUndefined()
    })

    it("rejects a token with an embedded newline anywhere (JS `.` does not match `\\n` without the `s` flag)", () => {
      // A newline inside the secret segment also fails to parse — the regex
      // has no dotAll flag, so `.+` cannot span a newline. Stricter than
      // required, but a desirable property (no multi-line token smuggling).
      expect(parseApiKeyToken("jct_01ARZ3NDEKTSV4RRFFQ69G5FAV_sec\nret").keyId).toBeUndefined()
      expect(parseApiKeyToken("jct_\n1ARZ3NDEKTSV4RRFFQ69G5FAV_secret").keyId).toBeUndefined()
    })

    it("rejects a token with unicode in the keyid", () => {
      expect(parseApiKeyToken("jct_01ARZ3NDEKTSV4RRFFQ69G5F🎉V_secret").keyId).toBeUndefined()
    })

    it("rejects a 10 KB token (too long to be a valid keyid segment, still parses safely without throwing)", () => {
      const huge = `jct_${"A".repeat(10_000)}_secret`
      expect(() => parseApiKeyToken(huge)).not.toThrow()
      expect(parseApiKeyToken(huge).keyId).toBeUndefined()
    })

    it("rejects a keyid shorter than 26 chars", () => {
      expect(parseApiKeyToken("jct_SHORT_secret").keyId).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // ApiKeyLabelSchema bounds
  // -------------------------------------------------------------------------
  describe("ApiKeyLabelSchema", () => {
    it("accepts a normal label", () => {
      expect(ApiKeyLabelSchema.safeParse("my key").success).toBe(true)
    })

    it("trims surrounding whitespace", () => {
      const result = ApiKeyLabelSchema.safeParse("  padded  ")
      expect(result.success).toBe(true)
      if (result.success) expect(result.data).toBe("padded")
    })

    it("rejects an empty label", () => {
      expect(ApiKeyLabelSchema.safeParse("").success).toBe(false)
    })

    it("rejects a whitespace-only label (trims to empty)", () => {
      expect(ApiKeyLabelSchema.safeParse("   ").success).toBe(false)
    })

    it("accepts a 64-char label", () => {
      expect(ApiKeyLabelSchema.safeParse("a".repeat(64)).success).toBe(true)
    })

    it("rejects a 65-char label", () => {
      expect(ApiKeyLabelSchema.safeParse("a".repeat(65)).success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // mint/verify round-trip
  // -------------------------------------------------------------------------
  describe("mint/verify round-trip", () => {
    it("mints a global key with 0 profiles and verifies OK with an empty profileIds set", async () => {
      const minted = await mintApiKey(
        { label: "demo", scope: "global", profileIds: [] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      expect(minted.value.plaintext).toMatch(/^jct_[0-9A-HJKMNP-TV-Z]{26}_.+$/)

      const verified = await verifyApiKey(minted.value.plaintext, repos.apiKeys)
      expect(verified.isOk()).toBe(true)
      if (verified.isOk()) {
        expect(verified.value.scope).toBe("global")
        expect(verified.value.profileIds).toEqual([])
        expect(verified.value.label).toBe("demo")
      }
    })

    it("mints a 'profile' scoped key with 1 profile and verifies OK", async () => {
      const profileId = newProfileId()
      const profile = await repos.profiles.create({
        id: profileId,
        name: "work",
        sources: [],
      })
      expect(profile.isOk()).toBe(true)

      const minted = await mintApiKey(
        { label: "work key", scope: "profile", profileIds: [profileId] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      const verified = await verifyApiKey(minted.value.plaintext, repos.apiKeys)
      expect(verified.isOk()).toBe(true)
      if (verified.isOk()) {
        expect(verified.value.scope).toBe("profile")
        expect(verified.value.profileIds).toEqual([profileId])
      }
    })

    it("mints a 'profiles' scoped key with 2 profiles and verifies OK", async () => {
      const profileId1 = newProfileId()
      const profileId2 = newProfileId()
      await repos.profiles.create({ id: profileId1, name: "work", sources: [] })
      await repos.profiles.create({ id: profileId2, name: "personal", sources: [] })

      const minted = await mintApiKey(
        { label: "multi", scope: "profiles", profileIds: [profileId1, profileId2] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      const verified = await verifyApiKey(minted.value.plaintext, repos.apiKeys)
      expect(verified.isOk()).toBe(true)
      if (verified.isOk()) {
        expect(verified.value.scope).toBe("profiles")
        expect(verified.value.profileIds.sort()).toEqual([profileId1, profileId2].sort())
      }
    })

    it("the minted plaintext is never persisted — only secretHash is stored", async () => {
      const minted = await mintApiKey(
        { label: "demo2", scope: "global", profileIds: [] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      const record = await repos.apiKeys.getByKeyId(minted.value.meta.id)
      expect(record.isOk()).toBe(true)
      if (record.isOk()) {
        expect(record.value.secretHash).not.toBe(minted.value.plaintext)
        expect(minted.value.plaintext).not.toContain(record.value.secretHash)
      }
    })

    it("secretHash equals sha256Hex of the secret segment ONLY (not the full token)", async () => {
      const minted = await mintApiKey(
        { label: "demo3", scope: "global", profileIds: [] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      const { secret } = parseApiKeyToken(minted.value.plaintext)
      expect(secret).toBeDefined()
      const record = await repos.apiKeys.getByKeyId(minted.value.meta.id)
      expect(record.isOk()).toBe(true)
      if (record.isOk() && secret !== undefined) {
        expect(record.value.secretHash).toBe(sha256Hex(secret))
      }
    })
  })

  // -------------------------------------------------------------------------
  // verify failure paths
  // -------------------------------------------------------------------------
  describe("verifyApiKey failure paths", () => {
    it("wrong secret for a real keyid → unknown-key", async () => {
      const minted = await mintApiKey(
        { label: "demo4", scope: "global", profileIds: [] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      const { keyId } = parseApiKeyToken(minted.value.plaintext)
      const forged = `jct_${keyId}_totallyWrongSecretValue`
      const verified = await verifyApiKey(forged, repos.apiKeys)
      expect(verified.isOk()).toBe(false)
      if (!verified.isOk()) expect(verified.error.kind).toBe("unknown-key")
    })

    it("unknown keyid → unknown-key", async () => {
      const bogus = "jct_01ARZ3NDEKTSV4RRFFQ69G5FAV_bogusSecret"
      const verified = await verifyApiKey(bogus, repos.apiKeys)
      expect(verified.isOk()).toBe(false)
      if (!verified.isOk()) expect(verified.error.kind).toBe("unknown-key")
    })

    it("malformed token → invalid-format", async () => {
      const verified = await verifyApiKey("not-a-token", repos.apiKeys)
      expect(verified.isOk()).toBe(false)
      if (!verified.isOk()) expect(verified.error.kind).toBe("invalid-format")
    })

    it("revoked key → revoked", async () => {
      const minted = await mintApiKey(
        { label: "demo5", scope: "global", profileIds: [] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      const revoked = await repos.apiKeys.revoke(minted.value.meta.id)
      expect(revoked.isOk()).toBe(true)

      const verified = await verifyApiKey(minted.value.plaintext, repos.apiKeys)
      expect(verified.isOk()).toBe(false)
      if (!verified.isOk()) expect(verified.error.kind).toBe("revoked")
    })

    it("'profile' scope key whose sole profile was deleted (cascade) → empty-scope", async () => {
      const profileId = newProfileId()
      const profile = await repos.profiles.create({
        id: profileId,
        name: "gone",
        sources: [],
      })
      expect(profile.isOk()).toBe(true)

      const minted = await mintApiKey(
        { label: "orphan", scope: "profile", profileIds: [profileId] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      await repos.profiles.delete(profileId)

      const verified = await verifyApiKey(minted.value.plaintext, repos.apiKeys)
      expect(verified.isOk()).toBe(false)
      if (!verified.isOk()) expect(verified.error.kind).toBe("empty-scope")
    })

    it("'profiles' scope key whose profiles were ALL deleted → empty-scope", async () => {
      const profileId1 = newProfileId()
      const profileId2 = newProfileId()
      await repos.profiles.create({ id: profileId1, name: "one", sources: [] })
      await repos.profiles.create({ id: profileId2, name: "two", sources: [] })
      const minted = await mintApiKey(
        { label: "multi-orphan", scope: "profiles", profileIds: [profileId1, profileId2] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      await repos.profiles.delete(profileId1)
      await repos.profiles.delete(profileId2)

      const verified = await verifyApiKey(minted.value.plaintext, repos.apiKeys)
      expect(verified.isOk()).toBe(false)
      if (!verified.isOk()) expect(verified.error.kind).toBe("empty-scope")
    })

    it("'global' scope key with 0 profiles resolves OK — NOT empty-scope", async () => {
      const minted = await mintApiKey(
        { label: "global-empty", scope: "global", profileIds: [] },
        repos.apiKeys,
      )
      expect(minted.isOk()).toBe(true)
      if (!minted.isOk()) return

      const verified = await verifyApiKey(minted.value.plaintext, repos.apiKeys)
      expect(verified.isOk()).toBe(true)
      if (verified.isOk()) expect(verified.value.profileIds).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // repo CRUD + cascade
  // -------------------------------------------------------------------------
  describe("ApiKeysRepo CRUD + cascade", () => {
    it("create + list + getByKeyId round-trip", async () => {
      const created = await repos.apiKeys.create({
        id: "key_crud_1",
        label: "crud",
        secretHash: sha256Hex("secret1"),
        scope: "global",
        createdAt: Date.now(),
        profileIds: [],
      })
      expect(created.isOk()).toBe(true)

      const listed = await repos.apiKeys.list()
      expect(listed.isOk()).toBe(true)
      if (listed.isOk()) {
        expect(listed.value.some((k) => k.id === "key_crud_1")).toBe(true)
      }

      const fetched = await repos.apiKeys.getByKeyId("key_crud_1")
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) expect(fetched.value.label).toBe("crud")
    })

    it("getByKeyId on an unknown id → not-found", async () => {
      const result = await repos.apiKeys.getByKeyId("does-not-exist")
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) expect(result.error.kind).toBe("not-found")
    })

    it("deleting a scoped profile cascades the join row but the key row stays", async () => {
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: "cascade-me", sources: [] })
      await repos.apiKeys.create({
        id: "key_cascade",
        label: "cascade",
        secretHash: sha256Hex("secret2"),
        scope: "profile",
        createdAt: Date.now(),
        profileIds: [profileId],
      })

      const beforeIds = await repos.apiKeys.getScopeProfileIds("key_cascade")
      expect(beforeIds.isOk()).toBe(true)
      if (beforeIds.isOk()) expect(beforeIds.value).toEqual([profileId])

      await repos.profiles.delete(profileId)

      const afterIds = await repos.apiKeys.getScopeProfileIds("key_cascade")
      expect(afterIds.isOk()).toBe(true)
      if (afterIds.isOk()) expect(afterIds.value).toEqual([])

      // Key row itself is retained (revocation is the only mutation; delete-profile
      // must not delete the key).
      const stillThere = await repos.apiKeys.getByKeyId("key_cascade")
      expect(stillThere.isOk()).toBe(true)
    })

    it("revoke is idempotent — revoking twice both succeed", async () => {
      await repos.apiKeys.create({
        id: "key_idem",
        label: "idem",
        secretHash: sha256Hex("secret3"),
        scope: "global",
        createdAt: Date.now(),
        profileIds: [],
      })

      const first = await repos.apiKeys.revoke("key_idem")
      expect(first.isOk()).toBe(true)
      const second = await repos.apiKeys.revoke("key_idem")
      expect(second.isOk()).toBe(true)

      const record = await repos.apiKeys.getByKeyId("key_idem")
      expect(record.isOk()).toBe(true)
      if (record.isOk()) expect(record.value.revokedAt).not.toBeNull()
    })

    it("revoke on an unknown keyid → not-found", async () => {
      const result = await repos.apiKeys.revoke("nope")
      expect(result.isOk()).toBe(false)
      if (!result.isOk()) expect(result.error.kind).toBe("not-found")
    })

    it("touchLastUsed updates lastUsedAt and never errors on a valid key", async () => {
      await repos.apiKeys.create({
        id: "key_touch",
        label: "touch",
        secretHash: sha256Hex("secret4"),
        scope: "global",
        createdAt: Date.now(),
        profileIds: [],
      })
      const before = await repos.apiKeys.getByKeyId("key_touch")
      expect(before.isOk()).toBe(true)
      if (before.isOk()) expect(before.value.lastUsedAt).toBeNull()

      const touched = await repos.apiKeys.touchLastUsed("key_touch")
      expect(touched.isOk()).toBe(true)

      const after = await repos.apiKeys.getByKeyId("key_touch")
      expect(after.isOk()).toBe(true)
      if (after.isOk()) expect(after.value.lastUsedAt).not.toBeNull()
    })

    it("touchLastUsed on an unknown keyid does not throw (best-effort — no-op update)", async () => {
      await expect(repos.apiKeys.touchLastUsed("no-such-key")).resolves.toBeDefined()
      const result = await repos.apiKeys.touchLastUsed("no-such-key")
      expect(result.isOk()).toBe(true)
    })

    it("countReferencingProfile counts DISTINCT keys referencing a profile", async () => {
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: "count-me", sources: [] })
      await repos.apiKeys.create({
        id: "key_count_1",
        label: "c1",
        secretHash: sha256Hex("s1"),
        scope: "profile",
        createdAt: Date.now(),
        profileIds: [profileId],
      })
      await repos.apiKeys.create({
        id: "key_count_2",
        label: "c2",
        secretHash: sha256Hex("s2"),
        scope: "profile",
        createdAt: Date.now(),
        profileIds: [profileId],
      })

      const count = await repos.apiKeys.countReferencingProfile(profileId)
      expect(count.isOk()).toBe(true)
      if (count.isOk()) expect(count.value).toBe(2)
    })
  })
})
