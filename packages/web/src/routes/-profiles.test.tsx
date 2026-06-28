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
  it("renders the page heading", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<ProfilesPage />)
    expect(getByRole("heading", { name: "Profiles" })).toBeInTheDocument()
  })

  it("shows empty state when no profiles", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByText } = render(<ProfilesPage />)
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

  it("shows 'No sources configured.' for profiles without sources", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByText } = render(<ProfilesPage />)
    expect(getByText("No sources configured.")).toBeInTheDocument()
  })
})
