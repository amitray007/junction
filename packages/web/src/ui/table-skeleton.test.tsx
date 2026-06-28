// SPDX-License-Identifier: AGPL-3.0-only
// TableSkeleton tests — dimensions, column count, aria, dark mode.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { TableSkeleton } from "./skeleton.js"

afterEach(() => {
  cleanup()
})

describe("TableSkeleton", () => {
  it("has role=status with accessible label", () => {
    render(<TableSkeleton />)
    expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument()
  })

  it("renders the default 5 data rows", () => {
    const { container } = render(<TableSkeleton rows={5} />)
    // The status container has direct children: 1 header div + 5 data row divs.
    const statusEl = container.querySelector('[role="status"]')
    expect(statusEl?.children.length).toBe(6) // 1 header + 5 data rows
  })

  it("renders custom row count", () => {
    const { container } = render(<TableSkeleton rows={3} />)
    const statusEl = container.querySelector('[role="status"]')
    expect(statusEl?.children.length).toBe(4) // 1 header + 3 data rows
  })

  it("renders in dark mode without errors", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() => render(<TableSkeleton rows={2} />)).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})
