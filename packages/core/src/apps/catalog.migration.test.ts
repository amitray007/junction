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

  // NOTE (inc 30.13): the migration snapshot's job is to prove the 30.8 JSON migration
  // was FAITHFUL — i.e. every pre-30.8 app SURVIVES with its identity intact. It is NOT
  // a freeze on the catalog growing: 30.13 curates NET-NEW apps (exa, twitter, sonarqube,
  // googlecloud, outline, hubspot, influxdb, goalert, posthog) and authors `surfaces[]`
  // (which can legitimately grow an app's `supportedKinds`, e.g. discord gained "http").
  // So the assertions are: old ⊆ new (superset OK), and each OLD app's IMMUTABLE identity
  // fields still round-trip. `supportedKinds` is NO LONGER pinned byte-identically — it's
  // the legacy capability list that surfaces[] supersedes (32.6c principle); a surface-add
  // may extend it. We assert instead that no old kind was DROPPED (old ⊆ new kinds).
  it("every pre-30.8 app id still exists in the new catalog (old ⊆ new — no silent drop)", () => {
    const newIds = new Set(newApps.map((a) => a.id))
    for (const old of oldApps) {
      expect(newIds.has(old.id), `pre-30.8 app "${old.id}" was dropped from the new catalog`).toBe(
        true,
      )
    }
  })

  it("every old app's IMMUTABLE identity fields round-trip through the new catalog", () => {
    for (const old of oldApps) {
      const migrated = getApp(old.id)
      expect(migrated, `app "${old.id}" missing from the new catalog`).toBeDefined()
      if (!migrated) continue
      expect(migrated.displayName).toBe(old.displayName)
      // supportedKinds: a surface-add (inc 30.13) may EXTEND it — assert old ⊆ new, not equal
      // (surfaces[] is the authoritative capability source; supportedKinds is legacy).
      for (const kind of old.supportedKinds) {
        expect(
          migrated.supportedKinds.includes(kind),
          `app "${old.id}" dropped supportedKind "${kind}"`,
        ).toBe(true)
      }
      expect(migrated.auth).toEqual(old.auth)
      expect(migrated.aliases).toEqual(old.aliases)
      expect(migrated.setupHints).toEqual(old.setupHints)
      expect(migrated.iconSlug).toBe(old.iconSlug)
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
