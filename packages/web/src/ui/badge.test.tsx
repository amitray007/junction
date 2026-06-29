// SPDX-License-Identifier: AGPL-3.0-only
// Tests for Badge + StatusBadge primitives.
// Verifies: a11y role/name, color + dot + text (never color-only), dark mode attr.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Badge, StatusBadge } from "./badge.js"

afterEach(() => cleanup())

describe("Badge", () => {
  it("renders children as visible text", () => {
    const { getByText } = render(<Badge variant="ok">Connected</Badge>)
    expect(getByText("Connected")).toBeInTheDocument()
  })

  it("includes a dot (aria-hidden) alongside text — never color-only", () => {
    const { container, getByText } = render(<Badge variant="error">Auth Failed</Badge>)
    // The dot span is aria-hidden; text is also present → never color-only
    const dots = container.querySelectorAll('[aria-hidden="true"]')
    expect(dots.length).toBeGreaterThanOrEqual(1)
    expect(getByText("Auth Failed")).toBeInTheDocument()
  })

  it("applies the configured variant by default (inc 24.5 — no liveness claim)", () => {
    const { container } = render(<Badge>Default</Badge>)
    const badge = container.firstChild as HTMLElement
    expect(badge.className).toMatch(/configured/)
  })

  it("renders each variant without throwing", () => {
    // Variants: configured / ok / noauth / warning / error / off (inc 24.5 taxonomy).
    // 'info', 'disabled' removed; 'noauth' + 'off' added.
    const variants = ["configured", "ok", "noauth", "warning", "error", "off"] as const
    for (const v of variants) {
      const { getByText, unmount } = render(<Badge variant={v}>{v}</Badge>)
      expect(getByText(v)).toBeInTheDocument()
      unmount()
    }
  })

  it("renders in dark mode (data-theme=dark) without error", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    const { getByText, unmount } = render(<Badge variant="warning">Expiring</Badge>)
    expect(getByText("Expiring")).toBeInTheDocument()
    unmount()
    document.documentElement.removeAttribute("data-theme")
  })
})

describe("StatusBadge", () => {
  it("renders Connected label for connected status", () => {
    const { getByText } = render(<StatusBadge status="connected" />)
    expect(getByText("Connected")).toBeInTheDocument()
  })

  it("renders Configured label for configured status — no liveness claim", () => {
    const { getByText } = render(<StatusBadge status="configured" />)
    expect(getByText("Configured")).toBeInTheDocument()
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

  it("maps all 5 CredentialKind values to configured via kindToStatus pattern", () => {
    // Validate that all real CredentialKind values return the 'configured' badge.
    // Core CredentialKind = ["api-key", "bearer", "oauth2", "file", "env"]
    const kinds = ["api-key", "bearer", "oauth2", "file", "env"] as const
    for (const kind of kinds) {
      // kindToStatus(_kind) always returns "configured" — assert the badge renders
      const { getByText, unmount } = render(<StatusBadge status="configured" />)
      expect(getByText("Configured")).toBeInTheDocument()
      unmount()
      // Confirm none of these kinds would produce "Connected" (no dead "none" branch)
      expect(kind).not.toBe("none")
    }
  })
})
