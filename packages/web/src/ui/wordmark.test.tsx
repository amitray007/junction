// SPDX-License-Identifier: AGPL-3.0-only
// Tests for Wordmark — a11y label, Departure Mono usage, amber node.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Wordmark } from "./wordmark.js"

afterEach(() => cleanup())

describe("Wordmark", () => {
  it("has aria-label 'Junction'", () => {
    const { getByLabelText } = render(<Wordmark />)
    expect(getByLabelText("Junction")).toBeInTheDocument()
  })

  it("renders JUNCTION text (aria-hidden — label carries the name)", () => {
    const { container } = render(<Wordmark />)
    const hidden = container.querySelectorAll('[aria-hidden="true"]')
    const textSpan = Array.from(hidden).find((el) => el.textContent === "JUNCTION")
    expect(textSpan).toBeDefined()
  })

  it("uses the display font CSS var for the JUNCTION text span", () => {
    const { container } = render(<Wordmark />)
    const hidden = container.querySelectorAll('[aria-hidden="true"]')
    const textSpan = Array.from(hidden).find((el) => el.textContent === "JUNCTION") as
      | HTMLElement
      | undefined
    // In happy-dom CSS vars aren't resolved; we verify the var() reference is set.
    // The discipline rule (Departure Mono wordmark-only) is enforced by the reviewer.
    expect(textSpan?.style.fontFamily).toContain("var(--font-display)")
  })

  it("renders the amber node square (aria-hidden, no text)", () => {
    const { container } = render(<Wordmark />)
    const hidden = container.querySelectorAll('[aria-hidden="true"]')
    const nodeSquare = Array.from(hidden).find((el) => el.textContent === "")
    expect(nodeSquare).toBeDefined()
  })

  it("renders in dark mode without error", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    const { getByLabelText } = render(<Wordmark />)
    expect(getByLabelText("Junction")).toBeInTheDocument()
    document.documentElement.removeAttribute("data-theme")
  })
})
