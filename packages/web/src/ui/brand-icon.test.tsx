// SPDX-License-Identifier: AGPL-3.0-only
// Tests for BrandIcon — the per-app brand glyph (increment 30.5 v2).
// Proves: a "color" slug renders its real inline markup (non-vacuous — real
// child elements, not blank); a "themed" slug (github) renders BOTH light and
// dark <svg> with the CSS-swap classes; a "mono" slug renders
// fill="currentColor"; an unknown/undefined slug renders the LetterTile
// fallback; glyphs are aria-hidden.
//
// The generated catalog is github-only since the inc 35 strip-down (see
// docs/methods/35-catalog-stripdown.md) — github is the sole surviving
// BRAND_ICONS entry and it's "themed". The "color"/"mono" category tests
// below inject a synthetic BRAND_ICONS entry (BRAND_ICONS is a plain runtime
// object; the `Readonly` wrapper is compile-time only) so BrandIcon's
// category-dispatch behavior stays under real test coverage rather than
// going untested until a color/mono app is reintroduced.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { BrandIcon } from "./brand-icon.js"
import { BRAND_ICONS } from "./brand-icons.generated.js"

afterEach(() => cleanup())

const SYNTHETIC_COLOR_SLUG = "synthetic-color-app"
const SYNTHETIC_MONO_SLUG = "synthetic-mono-app"

// Cast away the `Readonly` type wrapper — BRAND_ICONS is a plain object at
// runtime, so writing a synthetic test-only entry is safe; deleted in
// afterEach so it never leaks between tests.
const mutableBrandIcons = BRAND_ICONS as Record<string, (typeof BRAND_ICONS)[string]>

afterEach(() => {
  delete mutableBrandIcons[SYNTHETIC_COLOR_SLUG]
  delete mutableBrandIcons[SYNTHETIC_MONO_SLUG]
})

// The glyph is DECORATIVE (always beside the visible app name) → aria-hidden,
// so it is absent from the accessibility tree. Tests assert on the rendered DOM
// (svg contents / the letter), not on an ARIA role.

describe("BrandIcon", () => {
  it("renders real inline markup for a 'color' category slug (non-vacuous)", () => {
    mutableBrandIcons[SYNTHETIC_COLOR_SLUG] = {
      category: "color",
      viewBox: { color: "0 0 24 24" },
      render: { color: () => <path d="M0 0h24v24H0z" /> },
    }
    const { container } = render(<BrandIcon slug={SYNTHETIC_COLOR_SLUG} displayName="Synthetic" />)
    const svgs = container.querySelectorAll("svg")
    expect(svgs).toHaveLength(1)
    const svg = svgs[0]
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24")
    // Non-vacuous: real markup, not an empty <svg>.
    expect(svg?.children.length).toBeGreaterThan(0)
    expect(svg?.querySelector("path")).toBeInTheDocument()
  })

  it("renders BOTH light and dark <svg> for a 'themed' category slug (github), CSS-swap classed", () => {
    expect(BRAND_ICONS.github?.category).toBe("themed")
    const { container } = render(<BrandIcon slug="github" displayName="GitHub" />)
    const light = container.querySelector("svg.brand-icon-light")
    const dark = container.querySelector("svg.brand-icon-dark")
    expect(light).toBeInTheDocument()
    expect(dark).toBeInTheDocument()
    // Both carry real markup, not blank glyphs.
    expect(light?.querySelector("path")).toBeInTheDocument()
    expect(dark?.querySelector("path")).toBeInTheDocument()
    expect(light).toHaveAttribute("viewBox", BRAND_ICONS.github?.viewBox.light)
    expect(dark).toHaveAttribute("viewBox", BRAND_ICONS.github?.viewBox.dark)
  })

  it("renders fill=currentColor for a 'mono' category slug", () => {
    mutableBrandIcons[SYNTHETIC_MONO_SLUG] = {
      category: "mono",
      viewBox: { mono: "0 0 24 24" },
      render: { mono: () => <path d="M0 0h24v24H0z" /> },
    }
    const { container } = render(<BrandIcon slug={SYNTHETIC_MONO_SLUG} displayName="Synthetic" />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("fill", "currentColor")
    expect(svg?.querySelector("path")).toBeInTheDocument()
  })

  it("marks every glyph aria-hidden (decorative — the app name is visible beside it)", () => {
    mutableBrandIcons[SYNTHETIC_COLOR_SLUG] = {
      category: "color",
      viewBox: { color: "0 0 24 24" },
      render: { color: () => <path d="M0 0h24v24H0z" /> },
    }
    const color = render(<BrandIcon slug={SYNTHETIC_COLOR_SLUG} displayName="Synthetic" />)
    for (const svg of color.container.querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("aria-hidden", "true")
    }
    cleanup()
    const themed = render(<BrandIcon slug="github" displayName="GitHub" />)
    for (const svg of themed.container.querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("aria-hidden", "true")
    }
  })

  it("renders the first-letter tile fallback for an undefined slug — never blank", () => {
    const { container } = render(<BrandIcon displayName="Doppler" />)
    expect(container).toHaveTextContent("D")
    expect(container.querySelector("svg")).not.toBeInTheDocument()
    // Fallback tile is also decorative (name is visible beside it).
    expect(container.querySelector("span")).toHaveAttribute("aria-hidden", "true")
  })

  it("renders the first-letter tile fallback for an unknown/unmapped slug — never blank", () => {
    const { container } = render(<BrandIcon slug="not-a-real-slug" displayName="Mystery Thing" />)
    expect(container).toHaveTextContent("M")
    expect(container.querySelector("svg")).not.toBeInTheDocument()
  })

  it("renders in dark mode without throwing", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() => render(<BrandIcon slug="github" displayName="GitHub" />)).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })

  it("renders in light mode without throwing", () => {
    document.documentElement.setAttribute("data-theme", "light")
    expect(() => render(<BrandIcon slug="github" displayName="GitHub" />)).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})
