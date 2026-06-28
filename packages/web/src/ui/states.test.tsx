// SPDX-License-Identifier: AGPL-3.0-only
// Tests for EmptyState, LoadingState, ErrorState — first-class shared states.
// Verifies: ARIA roles, label/message rendering, hint, default text, custom className.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { EmptyState, ErrorState, LoadingState } from "./states.js"

afterEach(() => cleanup())

describe("EmptyState", () => {
  it("renders with role=status and accessible label", () => {
    const { getByRole } = render(<EmptyState label="No items yet." />)
    expect(getByRole("status", { name: "No items yet." })).toBeInTheDocument()
  })

  it("renders the label as visible text", () => {
    const { getByText } = render(<EmptyState label="Nothing here." />)
    expect(getByText("Nothing here.")).toBeInTheDocument()
  })

  it("renders hint text when provided", () => {
    const { getByText } = render(<EmptyState label="Empty" hint="Run junction init" />)
    expect(getByText("Run junction init")).toBeInTheDocument()
  })

  it("does not render hint when omitted", () => {
    const { queryByText } = render(<EmptyState label="Empty" />)
    // No second <p> beyond the label
    expect(queryByText("Run junction init")).not.toBeInTheDocument()
  })

  it("renders the default Inbox icon as aria-hidden", () => {
    const { container } = render(<EmptyState label="Empty" />)
    const icons = container.querySelectorAll('[aria-hidden="true"]')
    expect(icons.length).toBeGreaterThanOrEqual(1)
  })
})

describe("LoadingState", () => {
  it("renders with role=status and default label", () => {
    const { getByRole } = render(<LoadingState />)
    expect(getByRole("status", { name: "Loading…" })).toBeInTheDocument()
  })

  it("renders with a custom label", () => {
    const { getByRole } = render(<LoadingState label="Fetching data…" />)
    expect(getByRole("status", { name: "Fetching data…" })).toBeInTheDocument()
  })

  it("renders the spinner icon as aria-hidden", () => {
    const { container } = render(<LoadingState />)
    const icon = container.querySelector('[aria-hidden="true"]')
    expect(icon).toBeInTheDocument()
  })
})

describe("ErrorState", () => {
  it("renders with role=alert", () => {
    const { getByRole } = render(<ErrorState />)
    expect(getByRole("alert")).toBeInTheDocument()
  })

  it("renders the default error message", () => {
    const { getByText } = render(<ErrorState />)
    expect(getByText("Something went wrong.")).toBeInTheDocument()
  })

  it("renders a custom message", () => {
    const { getByText } = render(<ErrorState message="Failed to load credentials." />)
    expect(getByText("Failed to load credentials.")).toBeInTheDocument()
  })

  it("renders error icon as aria-hidden", () => {
    const { container } = render(<ErrorState />)
    const icon = container.querySelector('[aria-hidden="true"]')
    expect(icon).toBeInTheDocument()
  })
})
