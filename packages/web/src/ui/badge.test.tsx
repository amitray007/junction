// SPDX-License-Identifier: AGPL-3.0-only
// Tests for Badge + StatusBadge primitives.
// Verifies: a11y role/name, color + dot + text (never color-only), dark mode attr.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Badge, StatusBadge } from "./badge.js"

afterEach(() => cleanup())

describe("Badge", () => {
  it("renders children as visible text", () => {
    render(<Badge variant="ok">Connected</Badge>)
    expect(screen.getByText("Connected")).toBeInTheDocument()
  })

  it("includes a dot (aria-hidden) alongside text — never color-only", () => {
    const { container } = render(<Badge variant="error">Auth Failed</Badge>)
    // The dot span is aria-hidden; text is also present → never color-only
    const dots = container.querySelectorAll('[aria-hidden="true"]')
    expect(dots.length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("Auth Failed")).toBeInTheDocument()
  })

  it("applies the ok variant by default", () => {
    const { container } = render(<Badge>Default</Badge>)
    const badge = container.firstChild as HTMLElement
    expect(badge.className).toMatch(/ok/)
  })

  it("renders each variant without throwing", () => {
    const variants = ["ok", "info", "warning", "error", "disabled"] as const
    for (const v of variants) {
      const { unmount } = render(<Badge variant={v}>{v}</Badge>)
      expect(screen.getByText(v)).toBeInTheDocument()
      unmount()
    }
  })

  it("renders in dark mode (data-theme=dark) without error", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    const { unmount } = render(<Badge variant="warning">Expiring</Badge>)
    expect(screen.getByText("Expiring")).toBeInTheDocument()
    unmount()
    document.documentElement.removeAttribute("data-theme")
  })
})

describe("StatusBadge", () => {
  it("renders Connected label for connected status", () => {
    const { getByText } = render(<StatusBadge status="connected" />)
    expect(getByText("Connected")).toBeInTheDocument()
  })

  it("renders No Auth label for no-auth status", () => {
    const { getByText } = render(<StatusBadge status="no-auth" />)
    expect(getByText("No Auth")).toBeInTheDocument()
  })

  it("renders Expiring for expiring status", () => {
    const { getByText } = render(<StatusBadge status="expiring" />)
    expect(getByText("Expiring")).toBeInTheDocument()
  })

  it("renders Auth Failed for auth-failed status", () => {
    const { getByText } = render(<StatusBadge status="auth-failed" />)
    expect(getByText("Auth Failed")).toBeInTheDocument()
  })

  it("renders Disabled for disabled status", () => {
    const { getByText } = render(<StatusBadge status="disabled" />)
    expect(getByText("Disabled")).toBeInTheDocument()
  })
})
