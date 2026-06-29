// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /profiles.
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProfileMeta } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

const emptyData: ProfileMeta[] = []

const populatedData: ProfileMeta[] = [
  {
    id: "prof-1",
    name: "default",
    mcpEndpointPath: "/tmp/junction/mcp/default.sock",
    sources: [
      {
        namespace: "github",
        platform: "github",
        credentialAccount: "alice",
        enabled: true,
      },
      {
        namespace: "linear",
        platform: "linear",
        credentialAccount: "alice",
        enabled: false,
      },
    ],
  },
  {
    id: "prof-2",
    name: "readonly",
    mcpEndpointPath: "/tmp/junction/mcp/readonly.sock",
    sources: [],
  },
]

// ---- Mocks ------------------------------------------------------------------

const mockUseLoaderData = vi.fn().mockReturnValue(emptyData)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
}))

vi.mock("../server/data.functions.js", () => ({
  getProfiles: vi.fn(),
}))

const { Route } = await import("./profiles.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — typing the internal options shape is not worth the boilerplate
const ProfilesPage = (Route as any).options.component as React.FC

// ---- Tests ------------------------------------------------------------------

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
})

describe("ProfilesPage", () => {
  it("renders the page heading as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<ProfilesPage />)
    expect(getByRole("heading", { level: 1, name: "Profiles" })).toBeInTheDocument()
  })

  it("shows empty table with header + message row when no profiles (B3)", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole, getByText } = render(<ProfilesPage />)
    // Table always rendered — header present
    expect(getByRole("table")).toBeInTheDocument()
    // Empty message in a full-width row
    expect(getByText("No profiles yet.")).toBeInTheDocument()
  })

  it("renders profile names when populated", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByText } = render(<ProfilesPage />)
    expect(getByText("default")).toBeInTheDocument()
    expect(getByText("readonly")).toBeInTheDocument()
  })

  it("renders 'Configured' badge for enabled sources (not 'Connected')", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getAllByText, queryAllByText } = render(<ProfilesPage />)
    // Enabled source → "Configured", not "Connected"
    expect(getAllByText("Configured").length).toBeGreaterThanOrEqual(1)
    expect(queryAllByText("Connected").length).toBe(0)
  })

  it("renders 'Disabled' badge for disabled sources", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getAllByText } = render(<ProfilesPage />)
    expect(getAllByText("Disabled").length).toBeGreaterThanOrEqual(1)
  })

  it("shows 'No routes configured.' for profiles without sources (inc 24.5 RouteRow wording)", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByText } = render(<ProfilesPage />)
    expect(getByText("No routes configured.")).toBeInTheDocument()
  })

  it("does not render mcpEndpointPath anywhere (single-endpoint model, not shown in UI)", () => {
    // mcpEndpointPath is on ProfileMeta for CLI/MCP use but MUST NOT appear in the web UI.
    // The single-endpoint model (per-profile stdio, no HTTP shown) is enforced here.
    mockUseLoaderData.mockReturnValue(populatedData)
    const { queryByText } = render(<ProfilesPage />)
    expect(queryByText("/tmp/junction/mcp/default.sock")).not.toBeInTheDocument()
    expect(queryByText("/tmp/junction/mcp/readonly.sock")).not.toBeInTheDocument()
  })

  it("renders a single consolidated CLI affordance per card with real command names (inc 24.6)", () => {
    // inc 24.6: 2 ComingSoonAction pills per card (Add Route + Toggle Route) consolidated to
    // 1 quiet text block with the real CLI command names.
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getAllByText } = render(<ProfilesPage />)
    // "junction profile add-source" must appear — once per profile card (2 cards)
    expect(getAllByText("junction profile add-source").length).toBeGreaterThanOrEqual(1)
    expect(getAllByText("junction profile enable-source").length).toBeGreaterThanOrEqual(1)
    expect(getAllByText("junction profile disable-source").length).toBeGreaterThanOrEqual(1)
  })

  it("shows quiet create hint in page header (not a disabled button cluster, inc 24.6)", () => {
    // inc 24.6: the ComingSoonAction cluster in the page header is replaced by a single
    // inline text hint with the real CLI command. Both the page header actions slot AND the
    // empty-state hint contain "junction profile create", so use getAllByText.
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getAllByText } = render(<ProfilesPage />)
    expect(getAllByText("junction profile create").length).toBeGreaterThanOrEqual(1)
  })
})
