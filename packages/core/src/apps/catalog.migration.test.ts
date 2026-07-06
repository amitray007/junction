// SPDX-License-Identifier: AGPL-3.0-only
// Migration correctness test (increment 30.8, method file §6): listApps()/
// getApp() must return the SAME ids + fields as the OLD APPS array —
// asserted by DIFFING against a frozen pre-migration snapshot COMPUTED FROM
// SOURCE (never a hardcoded count; a doc-review caught a wrong "47" literal
// in an earlier draft). The snapshot lives at
// __fixtures__/pre-30.8-catalog.ts — a verbatim copy of catalog.ts as it
// stood immediately before this increment's JSON migration.

import { describe, expect, it } from "vitest"
import { getApp as getOldApp, listApps as listOldApps } from "./__fixtures__/pre-30.8-catalog.js"
import { getApp, listApps } from "./catalog.js"

describe("migration correctness — new catalog vs. the frozen pre-migration snapshot", () => {
  const oldApps = listOldApps()
  const newApps = listApps()

  it("the same set of app ids exists on both sides (no silent pad/drop)", () => {
    const oldIds = new Set(oldApps.map((a) => a.id))
    const newIds = new Set(newApps.map((a) => a.id))
    expect(newIds).toEqual(oldIds)
  })

  it("every old app's core fields round-trip byte-identically through the new catalog", () => {
    for (const old of oldApps) {
      const migrated = getApp(old.id)
      expect(migrated, `app "${old.id}" missing from the new catalog`).toBeDefined()
      if (!migrated) continue
      expect(migrated.displayName).toBe(old.displayName)
      expect(migrated.supportedKinds).toEqual(old.supportedKinds)
      expect(migrated.auth).toEqual(old.auth)
      expect(migrated.aliases).toEqual(old.aliases)
      expect(migrated.setupHints).toEqual(old.setupHints)
      expect(migrated.iconSlug).toBe(old.iconSlug)
    }
  })

  it("no NEW app id was introduced that didn't exist in the old catalog", () => {
    const oldIds = new Set(oldApps.map((a) => a.id))
    for (const app of newApps) {
      expect(
        oldIds.has(app.id),
        `new catalog has an id "${app.id}" absent from the old array`,
      ).toBe(true)
    }
  })

  it("getApp/getOldApp agree for a spot-check of unknown ids", () => {
    expect(getApp("definitely-not-a-real-app-id")).toBeUndefined()
    expect(getOldApp("definitely-not-a-real-app-id")).toBeUndefined()
  })

  it("surface-less apps migrate cleanly: Google (oauth2 + openapi, zero surfaces) still groups", () => {
    // The design doc's motivating bug (§1): Google ships oauth2 + supportedKinds
    // ["openapi"] but no ready surface — the token has nowhere to go. This
    // increment's AppCatalogEntrySchema must express that (surfaces optional)
    // without breaking the app-level fields group.ts/appIdForConnection read.
    const google = getApp("google")
    expect(google).toBeDefined()
    expect(google?.supportedKinds).toEqual(["openapi"])
    expect(google?.auth).toEqual([{ mode: "oauth2", providerId: "google" }])
  })

  it("surface-less apps migrate cleanly: the byo escape-hatch app (wpgraphql) still groups", () => {
    const wpgraphql = getApp("wpgraphql")
    expect(wpgraphql).toBeDefined()
    expect(wpgraphql?.auth).toEqual([{ mode: "byo" }])
  })
})
