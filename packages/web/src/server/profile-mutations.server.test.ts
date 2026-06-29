// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for profile-mutations.server.ts helpers.
// Covers: error-message switch coverage, name-format guard, and happy/sad paths
// for create/delete/add/remove/toggle route mutations.
// Uses a real temp DB (same pattern as data.server.test.ts).

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRepositories, getDatabase, getPaths, newPlatformId } from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  mutateAddRoute,
  mutateCreateProfile,
  mutateDeleteProfile,
  mutateRemoveRoute,
  mutateToggleRoute,
} from "./profile-mutations.server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeRepos(home: string) {
  const prevHome = process.env.JUNCTION_HOME
  process.env.JUNCTION_HOME = home
  const dbResult = await getDatabase(getPaths())
  if (dbResult.isErr()) throw new Error(String(dbResult.error))
  if (prevHome === undefined) delete process.env.JUNCTION_HOME
  else process.env.JUNCTION_HOME = prevHome
  return createRepositories(dbResult.value)
}

describe("profile-mutations.server", () => {
  let tmpHome: string
  let prevHome: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "junction-pm-test-"))
    prevHome = process.env.JUNCTION_HOME
    process.env.JUNCTION_HOME = tmpHome
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    await rm(tmpHome, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // mutateCreateProfile — name-format guard
  // ---------------------------------------------------------------------------

  describe("mutateCreateProfile", () => {
    it("rejects an invalid name (uppercase)", async () => {
      const result = await mutateCreateProfile("BadName")
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toMatch(/lowercase/)
    })

    it("rejects an invalid name (spaces)", async () => {
      const result = await mutateCreateProfile("my profile")
      expect(result.ok).toBe(false)
    })

    it("creates a profile with a valid name and returns id + name", async () => {
      const result = await mutateCreateProfile("work")
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.name).toBe("work")
      expect(typeof result.id).toBe("string")
      expect(result.id.length).toBeGreaterThan(0)
    })

    it("returns error for duplicate profile name (constraint-violation)", async () => {
      await mutateCreateProfile("dupe")
      const second = await mutateCreateProfile("dupe")
      expect(second.ok).toBe(false)
      if (second.ok) throw new Error("expected error")
      expect(second.error).toContain("dupe")
    })
  })

  // ---------------------------------------------------------------------------
  // mutateDeleteProfile
  // ---------------------------------------------------------------------------

  describe("mutateDeleteProfile", () => {
    it("is a no-op (ok) for a non-existent profile id — repo.delete does not check existence", async () => {
      // profiles.delete() issues DELETE ... WHERE id = ? without an existence check,
      // so deleting a missing ID silently succeeds with { ok: true }.
      const result = await mutateDeleteProfile("nonexistent-id")
      expect(result.ok).toBe(true)
    })

    it("deletes an existing profile successfully", async () => {
      const created = await mutateCreateProfile("to-delete")
      if (!created.ok) throw new Error("create failed")
      const result = await mutateDeleteProfile(created.id)
      expect(result.ok).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // mutateAddRoute / mutateRemoveRoute / mutateToggleRoute
  // ---------------------------------------------------------------------------

  describe("mutateAddRoute", () => {
    it("returns error for invalid namespace (empty)", async () => {
      const created = await mutateCreateProfile("route-test")
      if (!created.ok) throw new Error("create failed")
      const result = await mutateAddRoute({
        profileId: created.id,
        platformId: "github",
        namespace: "",
      })
      expect(result.ok).toBe(false)
    })

    it("adds a route without a credential (public/no-auth source)", async () => {
      const created = await mutateCreateProfile("pub-route")
      if (!created.ok) throw new Error("create failed")

      // Seed a real platform so the FK is satisfied
      const repos = await makeRepos(tmpHome)
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "Test" })

      const result = await mutateAddRoute({
        profileId: created.id,
        platformId: String(platformId),
        namespace: "testns",
      })
      expect(result.ok).toBe(true)
    })

    it("returns duplicate-namespace error on second add with same namespace", async () => {
      const created = await mutateCreateProfile("dup-ns")
      if (!created.ok) throw new Error("create failed")

      const repos = await makeRepos(tmpHome)
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "Test" })

      await mutateAddRoute({
        profileId: created.id,
        platformId: String(platformId),
        namespace: "dupns",
      })
      const second = await mutateAddRoute({
        profileId: created.id,
        platformId: String(platformId),
        namespace: "dupns",
      })
      expect(second.ok).toBe(false)
      if (second.ok) throw new Error("expected error")
      expect(second.error).toContain("dupns")
    })
  })

  describe("mutateRemoveRoute", () => {
    it("returns not-found for a namespace that does not exist in the profile", async () => {
      const created = await mutateCreateProfile("remove-test")
      if (!created.ok) throw new Error("create failed")
      const result = await mutateRemoveRoute(created.id, "nons")
      expect(result.ok).toBe(false)
    })
  })

  describe("mutateToggleRoute", () => {
    it("returns not-found for a namespace that does not exist", async () => {
      const created = await mutateCreateProfile("toggle-test")
      if (!created.ok) throw new Error("create failed")
      const result = await mutateToggleRoute(created.id, "nons", false)
      expect(result.ok).toBe(false)
    })

    it("toggles an existing route enabled/disabled", async () => {
      const created = await mutateCreateProfile("toggle-real")
      if (!created.ok) throw new Error("create failed")

      const repos = await makeRepos(tmpHome)
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "T" })

      await mutateAddRoute({
        profileId: created.id,
        platformId: String(platformId),
        namespace: "tns",
      })

      const disable = await mutateToggleRoute(created.id, "tns", false)
      expect(disable.ok).toBe(true)

      const enable = await mutateToggleRoute(created.id, "tns", true)
      expect(enable.ok).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // profileErrorMessage — error-mapping switch coverage
  // ---------------------------------------------------------------------------

  describe("error message mapping (via observable mutation results)", () => {
    it("not-found maps to a human-readable message (via removeRoute on missing namespace)", async () => {
      // mutateRemoveRoute checks existence and returns a not-found error —
      // exercise the profileErrorMessage("not-found") branch.
      const created = await mutateCreateProfile("errmap-notfound")
      if (!created.ok) throw new Error("create failed")
      const result = await mutateRemoveRoute(created.id, "no-such-ns")
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      // The message should describe the failure meaningfully
      expect(result.error.length).toBeGreaterThan(0)
      expect(result.error).not.toBe("undefined")
    })

    it("duplicate-namespace maps to a human-readable message containing the namespace", async () => {
      const created = await mutateCreateProfile("errmap-test")
      if (!created.ok) throw new Error("create failed")
      const repos = await makeRepos(tmpHome)
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "T" })
      await mutateAddRoute({
        profileId: created.id,
        platformId: String(platformId),
        namespace: "dupns",
      })
      const dup = await mutateAddRoute({
        profileId: created.id,
        platformId: String(platformId),
        namespace: "dupns",
      })
      expect(dup.ok).toBe(false)
      if (dup.ok) throw new Error("expected error")
      expect(dup.error).toContain("dupns")
    })
  })
})
