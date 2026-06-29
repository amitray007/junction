// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for / (Dashboard).
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// ---- Fixtures ---------------------------------------------------------------

const emptyData = {
  home: "/home/user/.junction",
  initialized: true,
  credentialStore: "keyring",
  sandbox: "seatbelt",
  counts: { platforms: 0, credentials: 0, profiles: 0 },
}

const populatedData = {
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

  it("renders the stat cards list", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<DashboardPage />)
    expect(getByRole("list", { name: "Summary counts" })).toBeInTheDocument()
  })

  it("shows zero counts in stat cards", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getAllByText } = render(<DashboardPage />)
    // 3 stat cards show their counts; all are 0 → 3 elements with text "0"
    expect(getAllByText("0").length).toBeGreaterThanOrEqual(3)
  })

  it("shows populated counts in stat cards", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByText } = render(<DashboardPage />)
    expect(getByText("3")).toBeInTheDocument() // platforms
    expect(getByText("2")).toBeInTheDocument() // credentials
    expect(getByText("1")).toBeInTheDocument() // profiles
  })

  it("shows empty state when nothing is configured", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByText } = render(<DashboardPage />)
    expect(getByText("Nothing configured yet.")).toBeInTheDocument()
  })

  it("does not show empty state when data exists", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
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

  it("renders the Recent Activity section with a Coming soon pill", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getAllByText, getByRole } = render(<DashboardPage />)
    expect(getByRole("region", { name: /recent activity/i })).toBeInTheDocument()
    // Multiple "Coming soon" pills render (AgentConfig + Recent Activity) — assert at least one.
    expect(getAllByText("Coming soon").length).toBeGreaterThanOrEqual(1)
  })
})
