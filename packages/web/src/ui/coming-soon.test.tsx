// SPDX-License-Identifier: AGPL-3.0-only
// Tests for ComingSoon primitives — pill, action wrapper, section variant.
// Verifies: visual text present, disabled state, CLI hint, no working action.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ComingSoon, ComingSoonAction, ComingSoonSection } from "./coming-soon.js"

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

  it("disabled button carries both HTML disabled and aria-disabled (belt-and-suspenders)", () => {
    const { getByRole } = render(<ComingSoonAction label="Add Route" />)
    const btn = getByRole("button", { name: "Add Route" })
    // Both guards must be present: HTML disabled blocks form submission; aria-disabled
    // communicates the state to assistive technology even when CSS hides the button.
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute("aria-disabled", "true")
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

describe("ComingSoonSection", () => {
  it("renders children when provided", () => {
    const { getByText } = render(
      <ComingSoonSection>
        <span>Illustration content</span>
      </ComingSoonSection>,
    )
    expect(getByText("Illustration content")).toBeInTheDocument()
  })

  it("renders Coming soon pill in the footer", () => {
    const { getByText } = render(<ComingSoonSection hint="Available in the next release." />)
    expect(getByText("Coming soon")).toBeInTheDocument()
  })

  it("renders hint text in the footer when provided", () => {
    const { getByText } = render(<ComingSoonSection hint="Available in the next release." />)
    expect(getByText("Available in the next release.")).toBeInTheDocument()
  })
})
