// SPDX-License-Identifier: AGPL-3.0-only
// PageHeader tests — title, count chip, subtitle, actions slot, dark mode.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { PageHeader, PageHeaderSkeleton } from "./page-header.js"

afterEach(() => {
  cleanup()
})

describe("PageHeader", () => {
  it("renders the title as an h1", () => {
    render(<PageHeader title="Credentials" />)
    expect(screen.getByRole("heading", { level: 1, name: "Credentials" })).toBeInTheDocument()
  })

  it("renders count chip when count is provided", () => {
    render(<PageHeader title="Platforms" count={3} />)
    // Badge text "3" should appear
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("does not render count chip when count is undefined", () => {
    render(<PageHeader title="Profiles" />)
    // No numeric badge beside the title
    expect(screen.queryByLabelText(/profiles/i)).not.toBeInTheDocument()
  })

  it("renders subtitle when provided", () => {
    render(<PageHeader title="Dashboard" subtitle="Junction management surface" />)
    expect(screen.getByText("Junction management surface")).toBeInTheDocument()
  })

  it("renders actions slot content", () => {
    render(<PageHeader title="Credentials" actions={<button type="button">Add</button>} />)
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument()
  })

  it("renders in dark mode without errors", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() => render(<PageHeader title="Dark header" count={5} />)).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})

describe("PageHeaderSkeleton", () => {
  it("renders aria-hidden placeholder", () => {
    const { container } = render(<PageHeaderSkeleton />)
    // The skeleton div is aria-hidden
    const skeleton = container.querySelector('[aria-hidden="true"]')
    expect(skeleton).toBeInTheDocument()
  })
})
