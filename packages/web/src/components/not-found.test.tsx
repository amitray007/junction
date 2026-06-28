// SPDX-License-Identifier: AGPL-3.0-only
// Tests for NotFound (404) component.
// Verifies: heading, accessible text, back-link target.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

const { NotFound } = await import("./not-found.js")

afterEach(() => cleanup())

describe("NotFound", () => {
  it("renders the 'Page not found' heading", () => {
    const { getByRole } = render(<NotFound />)
    expect(getByRole("heading", { name: "Page not found" })).toBeInTheDocument()
  })

  it("renders the descriptive sub-text", () => {
    const { getByText } = render(<NotFound />)
    expect(getByText("That route doesn't exist on this dashboard.")).toBeInTheDocument()
  })

  it("renders a back-to-dashboard link", () => {
    const { getByRole } = render(<NotFound />)
    const link = getByRole("link", { name: "Back to Dashboard" })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute("href", "/")
  })

  it("renders the 404 glyph as aria-hidden (not exposed to SR)", () => {
    const { container } = render(<NotFound />)
    const hidden = container.querySelector('[aria-hidden="true"]')
    expect(hidden).toBeInTheDocument()
    expect(hidden?.textContent).toBe("404")
  })
})
