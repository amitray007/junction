// SPDX-License-Identifier: AGPL-3.0-only
// Route test for /audit — the Coming-soon audit placeholder.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({ options }),
}))

const { Route } = await import("./audit.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — internal options shape
const AuditPage = (Route as any).options.component as React.FC

afterEach(cleanup)

describe("AuditPage", () => {
  it("renders the Audit heading", () => {
    const { getByRole } = render(<AuditPage />)
    expect(getByRole("heading", { level: 1, name: "Audit" })).toBeInTheDocument()
  })

  it("shows the coming-soon placeholder (no audit backend yet)", () => {
    const { getByText, getAllByText } = render(<AuditPage />)
    expect(getByText(/audit log isn't available yet/i)).toBeInTheDocument()
    // The ComingSoon pill is present in the header actions.
    expect(getAllByText(/coming soon/i).length).toBeGreaterThanOrEqual(1)
  })
})
