// SPDX-License-Identifier: AGPL-3.0-only
// Tests for StatusRail — a11y list role, segment states, empty state.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { RailSegment } from "./status-rail.js"
import { StatusRail } from "./status-rail.js"

afterEach(() => cleanup())

const segments: RailSegment[] = [
  { id: "github", state: "ok", label: "github" },
  { id: "linear", state: "warning", label: "linear" },
  { id: "slack", state: "error", label: "slack" },
  { id: "jira", state: "disabled", label: "jira" },
]

describe("StatusRail", () => {
  it("has an accessible label and list role", () => {
    const { getByRole } = render(<StatusRail segments={segments} />)
    expect(getByRole("list", { name: "Source status rail" })).toBeInTheDocument()
  })

  it("renders each segment as a listitem with state in its label", () => {
    const { getAllByRole } = render(<StatusRail segments={segments} />)
    const items = getAllByRole("listitem")
    // Verify at least one segment per state we care about
    expect(items.some((el) => el.getAttribute("aria-label") === "github: ok")).toBe(true)
    expect(items.some((el) => el.getAttribute("aria-label") === "linear: warning")).toBe(true)
    expect(items.some((el) => el.getAttribute("aria-label") === "slack: error")).toBe(true)
  })

  it("renders empty state placeholder when no segments", () => {
    const { container } = render(<StatusRail segments={[]} />)
    const placeholder = container.querySelector('[aria-hidden="true"]')
    expect(placeholder).toBeInTheDocument()
  })

  it("renders in dark mode without error", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    const { getByRole } = render(<StatusRail segments={segments} />)
    expect(getByRole("list", { name: "Source status rail" })).toBeInTheDocument()
    document.documentElement.removeAttribute("data-theme")
  })
})
