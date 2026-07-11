// SPDX-License-Identifier: AGPL-3.0-only
// Catalog <-> BRAND_ICONS (generated) sync test (increment 30.5 v2). This is
// the mechanical half of the "fail-loud" guarantee: the OTHER half (a slug
// disappearing from @thesvg/icons upstream) is caught by the codegen script
// itself (packages/web/scripts/gen-brand-icons.mjs) throwing a non-zero exit
// when it can't import a catalog iconSlug's module. This test catches the
// complementary drift: a catalog iconSlug added without regenerating
// brand-icons.generated.tsx — which compiles fine but would silently render
// the letter-tile fallback instead of the intended brand glyph.

import { listApps } from "@junction/core"
import { describe, expect, it } from "vitest"
import { BRAND_ICONS } from "./brand-icons.generated.js"

describe("BRAND_ICONS (generated) <-> catalog sync", () => {
  it("every catalog iconSlug has a generated BRAND_ICONS entry", () => {
    for (const app of listApps()) {
      if (app.iconSlug === undefined) continue
      expect(
        BRAND_ICONS[app.iconSlug],
        `catalog app "${app.id}" -> iconSlug "${app.iconSlug}"`,
      ).toBeDefined()
    }
  })

  it("every BRAND_ICONS entry has a non-empty viewBox + render fn for each of its category's slots", () => {
    for (const [slug, entry] of Object.entries(BRAND_ICONS)) {
      const slots =
        entry.category === "themed" ? (["light", "dark"] as const) : ([entry.category] as const)
      for (const slot of slots) {
        expect(entry.viewBox[slot], `${slug}.viewBox.${slot}`).toBeTruthy()
        expect(entry.render[slot], `${slug}.render.${slot}`).toBeTypeOf("function")
      }
    }
  })

  it("github is categorized 'themed' (light+dark)", () => {
    // The catalog was stripped to github-only in increment 35 (catalog
    // strip-down, docs/methods/35-catalog-stripdown.md) — the v2 icon source
    // (@thesvg/icons) vs. delisted-from-v1-simple-icons regression this test
    // pinned (slack/microsoft/vercel/railway/openai/notion) returns with
    // those apps' own increments (36+).
    expect(BRAND_ICONS.github?.category).toBe("themed")
  })
})
