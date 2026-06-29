// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /profiles — master-detail layout (Variant C, F13).
// Strategy: mock createFileRoute + useRouter so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PlatformMeta, ProfileMeta } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

const emptyProfiles: ProfileMeta[] = []
const emptyPlatforms: PlatformMeta[] = []

const emptyData = { profiles: emptyProfiles, platforms: emptyPlatforms }

const populatedData = {
  profiles: [
    {
      id: "prof-1",
      name: "default",
      mcpEndpointPath: "/profiles/default/mcp",
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
      mcpEndpointPath: "/profiles/readonly/mcp",
      sources: [],
    },
  ] satisfies ProfileMeta[],
  platforms: [] as PlatformMeta[],
}

// ---- Mocks ------------------------------------------------------------------

const mockInvalidate = vi.fn().mockResolvedValue(undefined)
const mockUseLoaderData = vi.fn().mockReturnValue(emptyData)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  useRouter: () => ({ invalidate: mockInvalidate }),
}))

vi.mock("../server/data.functions.js", () => ({
  getProfiles: vi.fn(),
  getPlatforms: vi.fn(),
}))

vi.mock("../server/profile-mutations.functions.js", () => ({
  createProfileFn: vi.fn(),
  deleteProfileFn: vi.fn(),
  addRouteFn: vi.fn(),
  removeRouteFn: vi.fn(),
  toggleRouteFn: vi.fn(),
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
    // Table rendered in empty state
    expect(getByRole("table")).toBeInTheDocument()
    expect(getByText("No profiles yet.")).toBeInTheDocument()
  })

  it("renders New Profile button (primary action)", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    render(<ProfilesPage />)
    // Empty state shows New Profile in the header AND in the empty table row — use getAllByRole
    expect(screen.getAllByRole("button", { name: /new profile/i }).length).toBeGreaterThanOrEqual(1)
  })

  it("renders master-detail layout when profiles exist (F13)", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    // Left list — both profile names visible as buttons
    expect(screen.getByRole("button", { name: /default/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /readonly/i })).toBeInTheDocument()
  })

  it("selects first profile by default and shows its detail (F13)", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    // The first profile's name appears in the detail heading (h2)
    expect(screen.getByRole("heading", { level: 2, name: "default" })).toBeInTheDocument()
  })

  it("renders route table with correct columns in detail view", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    // Route table headers
    expect(screen.getByRole("columnheader", { name: "Platform" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Namespace" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument()
  })

  it("renders 'Configured' badge for enabled sources", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    expect(screen.getAllByText("Configured").length).toBeGreaterThanOrEqual(1)
  })

  it("renders 'Disabled' badge for disabled sources", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    expect(screen.getAllByText("Disabled").length).toBeGreaterThanOrEqual(1)
  })

  it("shows empty route table row for profiles without sources (B3)", () => {
    // Select the second profile (readonly — no sources). Since tests can't click,
    // create data with only a no-source profile.
    mockUseLoaderData.mockReturnValue({
      profiles: [
        {
          id: "prof-2",
          name: "readonly",
          mcpEndpointPath: "/profiles/readonly/mcp",
          sources: [],
        },
      ],
      platforms: [],
    })
    render(<ProfilesPage />)
    expect(screen.getByText("No routes in this profile.")).toBeInTheDocument()
  })

  it("does not render mcpEndpointPath anywhere (single-endpoint model)", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    // The mcpEndpointPath (/profiles/default/mcp) must NOT appear literally in the UI.
    expect(screen.queryByText("/profiles/default/mcp")).not.toBeInTheDocument()
    expect(screen.queryByText("/profiles/readonly/mcp")).not.toBeInTheDocument()
  })

  it("shows CLI serve command (single-endpoint model) in detail panel", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    // CLI serve command — the correct no-HTTP affordance
    expect(screen.getByText(/junction mcp serve --profile default/)).toBeInTheDocument()
  })

  it("shows Add Route button in detail panel", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    expect(screen.getByRole("button", { name: /add route/i })).toBeInTheDocument()
  })

  it("shows ComingSoon for 'Keys active' (N keys active ComingSoon guard)", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    expect(screen.getByText("Keys active")).toBeInTheDocument()
  })

  it("renders profile list filter input", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    expect(screen.getByRole("searchbox", { name: /filter profiles/i })).toBeInTheDocument()
  })
})
