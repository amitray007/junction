// SPDX-License-Identifier: AGPL-3.0-only
// Tests for Wordmark — a11y label, Geist Sans usage (inc 24.5 rewrite).
// Departure Mono + amber square RETIRED; J glyph + "Junction" logotype in Geist Sans.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Wordmark } from "./wordmark.js"

afterEach(() => cleanup())

describe("Wordmark", () => {
  it("has aria-label 'Junction'", () => {
    const { getByLabelText } = render(<Wordmark />)
    expect(getByLabelText("Junction")).toBeInTheDocument()
  })

  it("renders 'Junction' logotype text (aria-hidden — label carries the name)", () => {
    const { container } = render(<Wordmark />)
    const hidden = container.querySelectorAll('[aria-hidden="true"]')
    const textSpan = Array.from(hidden).find((el) => el.textContent === "Junction")
    expect(textSpan).toBeDefined()
  })

  it("renders the J glyph span (aria-hidden, single letter J)", () => {
    const { container } = render(<Wordmark />)
    const hidden = container.querySelectorAll('[aria-hidden="true"]')
    const glyph = Array.from(hidden).find((el) => el.textContent === "J")
    expect(glyph).toBeDefined()
  })

  it("uses Geist Sans font var for the logotype span (not Departure Mono)", () => {
    const { container } = render(<Wordmark />)
    const hidden = container.querySelectorAll('[aria-hidden="true"]')
    const textSpan = Array.from(hidden).find((el) => el.textContent === "Junction") as
      | HTMLElement
      | undefined
    // In happy-dom CSS vars aren't resolved; we verify the var() reference is set.
    expect(textSpan?.style.fontFamily).toContain("var(--font-sans)")
    // Departure Mono must NOT appear on the logotype.
    expect(textSpan?.style.fontFamily).not.toContain("Departure Mono")
  })

  it("renders in dark mode without error", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    const { getByLabelText } = render(<Wordmark />)
    expect(getByLabelText("Junction")).toBeInTheDocument()
    document.documentElement.removeAttribute("data-theme")
  })
})
