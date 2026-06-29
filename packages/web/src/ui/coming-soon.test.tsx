// SPDX-License-Identifier: AGPL-3.0-only
// Tests for ComingSoon primitives — pill and action wrapper.
// ComingSoonSection was deleted (no consumer, L2 dead export).
// Verifies: visual text present, disabled state, CLI hint, no working action.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ComingSoon, ComingSoonAction } from "./coming-soon.js"

afterEach(() => cleanup())

describe("ComingSoon", () => {
  it("renders 'Coming soon' pill text", () => {
    const { getByText } = render(<ComingSoon />)
    expect(getByText("Coming soon")).toBeInTheDocument()
  })

  it("renders in dark mode without error", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    const { getByText } = render(<ComingSoon />)
    expect(getByText("Coming soon")).toBeInTheDocument()
    document.documentElement.removeAttribute("data-theme")
  })
})

describe("ComingSoonAction", () => {
  it("renders the label text", () => {
    const { getByText } = render(<ComingSoonAction label="Add Platform" />)
    expect(getByText("Add Platform")).toBeInTheDocument()
  })

  it("renders the Coming soon pill alongside the button", () => {
    const { getByText } = render(<ComingSoonAction label="New Profile" />)
    expect(getByText("New Profile")).toBeInTheDocument()
    expect(getByText("Coming soon")).toBeInTheDocument()
  })

  it("renders the disabled button as a button element", () => {
    const { getByRole } = render(<ComingSoonAction label="Add Route" />)
    const btn = getByRole("button", { name: "Add Route" })
    expect(btn).toBeInTheDocument()
    expect(btn).toBeDisabled()
  })

  it("disabled button is a real <button> element (not a div)", () => {
    const { getByRole } = render(<ComingSoonAction label="Add Route" />)
    const btn = getByRole("button", { name: "Add Route" })
    // Button component renders a native <button> — AT reads the disabled state directly
    // from the HTML disabled attribute without needing a separate aria-disabled.
    expect(btn.tagName).toBe("BUTTON")
    expect(btn).toBeDisabled()
  })

  it("renders CLI hint with cliHint prop", () => {
    const { getByText } = render(
      <ComingSoonAction label="Add Platform" cliHint="junction platform add" />,
    )
    expect(getByText("junction platform add")).toBeInTheDocument()
  })

  it("does not render hint paragraph when cliHint is omitted", () => {
    const { queryByText } = render(<ComingSoonAction label="New Profile" />)
    expect(queryByText(/for now/i)).not.toBeInTheDocument()
  })
})
