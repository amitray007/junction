// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for / (Dashboard).
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.

import { cleanup, render, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// ---- Fixtures ---------------------------------------------------------------

// System info (Store/Sandbox/Home) is no longer on the dashboard — it moved to the
// sidebar panel. The loader still returns DashboardData for the isEmpty counts check.

const emptyData = {
  home: "/home/user/.junction",
  initialized: true,
  credentialStore: "keyring",
  sandbox: "seatbelt",
  counts: { platforms: 0, credentials: 0, profiles: 0 },
  mcpHost: undefined as string | undefined,
}

const _populatedData = {
  ...emptyData,
  counts: { platforms: 3, credentials: 2, profiles: 1 },
}

// ---- Mocks ------------------------------------------------------------------

const mockUseLoaderData = vi.fn().mockReturnValue(emptyData)

// createFileRoute("/")({ loader, component }) — the inner call returns the route.
// We capture the component from the options object passed to the inner fn.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

// Server functions are server-only; mock them to avoid import errors.
vi.mock("../server/data.functions.js", () => ({
  getDashboard: vi.fn(),
  getSettings: vi.fn(),
}))

// Import AFTER mocks are registered.
const { Route } = await import("./index.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — typing the internal options shape is not worth the boilerplate
const DashboardPage = (Route as any).options.component as React.FC

// ---- Tests ------------------------------------------------------------------

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
})

describe("DashboardPage", () => {
  it("renders the page heading as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<DashboardPage />)
    expect(getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument()
  })

  it("does NOT render the overview block (System moved to sidebar)", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { queryByRole, queryByTestId } = render(<DashboardPage />)
    // The overview region and its At-a-Glance / System columns are gone.
    expect(queryByRole("region", { name: /overview/i })).not.toBeInTheDocument()
    expect(queryByTestId("overview-glance")).not.toBeInTheDocument()
    expect(queryByTestId("overview-system")).not.toBeInTheDocument()
  })

  it("does not render a first-run empty state (removed — feedback)", () => {
    // The "Nothing configured yet" first-run hint was removed from the dashboard.
    mockUseLoaderData.mockReturnValue(emptyData)
    const { queryByText } = render(<DashboardPage />)
    expect(queryByText("Nothing configured yet.")).not.toBeInTheDocument()
  })

  it("renders the Connect an Agent region", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<DashboardPage />)
    // AgentConfig lives inside a section with an aria heading "Connect an Agent"
    expect(getByRole("region", { name: /connect an agent/i })).toBeInTheDocument()
  })

  it("does not render a localhost URL in the agent config illustration", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { queryByText } = render(<DashboardPage />)
    expect(queryByText(/localhost/)).not.toBeInTheDocument()
  })

  it("renders the Recent Activity section as a link-card to /audit, with no Coming soon pill", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<DashboardPage />)
    const activity = getByRole("region", { name: /recent activity/i })
    // The section is a link-card to the real /audit page (inc 32.6b).
    expect(within(activity).getByRole("link")).toHaveAttribute("href", "/audit")
    // ComingSoon is gone WITHIN this section only — AgentConfig legitimately
    // renders its own "Coming soon" elsewhere on the page, so a page-wide
    // absence assertion would be wrong.
    expect(within(activity).queryByText("Coming soon")).not.toBeInTheDocument()
    expect(within(activity).queryByText(/coming in a later update/i)).not.toBeInTheDocument()
  })
})
