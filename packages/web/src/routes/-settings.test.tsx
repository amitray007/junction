// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /settings — Phase 1 stub (Phase 3 will expand).
// Verifies: h1 renders, landmark present (a11y rule: every route needs a landmark assertion).

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    options,
  }),
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string
    children: React.ReactNode
    [k: string]: unknown
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

const { Route } = await import("./settings.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility
const SettingsPage = (Route as any).options.component as React.FC

afterEach(() => cleanup())

describe("SettingsPage (Phase 1 stub)", () => {
  it("renders the page heading as <h1>", () => {
    const { getByRole } = render(<SettingsPage />)
    expect(getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument()
  })

  it("indicates this is a coming-soon stub (subtitle present)", () => {
    const { getByText } = render(<SettingsPage />)
    expect(getByText(/coming in this increment/i)).toBeInTheDocument()
  })
})
