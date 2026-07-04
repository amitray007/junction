// SPDX-License-Identifier: AGPL-3.0-only
// Tests for BrandIcon — the per-app brand glyph (increment 30.5 v2).
// Proves: a "color" slug renders its real inline markup (non-vacuous — real
// child elements, not blank); a "themed" slug (github) renders BOTH light and
// dark <svg> with the CSS-swap classes; the "mono" slug (notion) renders
// fill="currentColor"; an unknown/undefined slug renders the LetterTile
// fallback; glyphs are aria-hidden; slack/microsoft (removed from
// simple-icons, present in @thesvg/icons) now render REAL brand markup, not
// the letter-tile fallback.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { BrandIcon } from "./brand-icon.js"
import { BRAND_ICONS } from "./brand-icons.generated.js"

afterEach(() => cleanup())

// The glyph is DECORATIVE (always beside the visible app name) → aria-hidden,
// so it is absent from the accessibility tree. Tests assert on the rendered DOM
// (svg contents / the letter), not on an ARIA role.

describe("BrandIcon", () => {
  it("renders real inline markup for a 'color' category slug (non-vacuous)", () => {
    expect(BRAND_ICONS.gitlab?.category).toBe("color")
    const { container } = render(<BrandIcon slug="gitlab" displayName="GitLab" />)
    const svgs = container.querySelectorAll("svg")
    expect(svgs).toHaveLength(1)
    const svg = svgs[0]
    expect(svg).toHaveAttribute("viewBox", BRAND_ICONS.gitlab?.viewBox.color)
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

  it("renders fill=currentColor for a 'mono' category slug (notion)", () => {
    expect(BRAND_ICONS.notion?.category).toBe("mono")
    const { container } = render(<BrandIcon slug="notion" displayName="Notion" />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("fill", "currentColor")
    expect(svg?.querySelector("path")).toBeInTheDocument()
  })

  it("marks every glyph aria-hidden (decorative — the app name is visible beside it)", () => {
    const color = render(<BrandIcon slug="gitlab" displayName="GitLab" />)
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

  it("renders REAL brand markup for slack and microsoft (available in @thesvg/icons, unlike simple-icons)", () => {
    expect(BRAND_ICONS.slack?.category).toBe("color")
    expect(BRAND_ICONS.microsoft?.category).toBe("color")

    const slack = render(<BrandIcon slug="slack" displayName="Slack" />)
    expect(slack.container.querySelector("svg")).toBeInTheDocument()
    expect(slack.container.querySelector("svg path")).toBeInTheDocument()
    // NOT the letter-tile fallback.
    expect(slack.container.querySelector("span")).not.toBeInTheDocument()
    cleanup()

    const ms = render(<BrandIcon slug="microsoft" displayName="Microsoft" />)
    expect(ms.container.querySelector("svg")).toBeInTheDocument()
    expect(ms.container.querySelector("svg path")).toBeInTheDocument()
    expect(ms.container.querySelector("span")).not.toBeInTheDocument()
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
