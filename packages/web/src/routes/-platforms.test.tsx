// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /platforms.
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.
// Loader shape (inc 24.5): { platforms, connectionCounts } — derived from credentials.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PlatformMeta } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

// Loader now returns { platforms, connectionCounts } — useLoaderData must match.
const emptyLoaderData = { platforms: [] as PlatformMeta[], connectionCounts: {} }

const platforms: PlatformMeta[] = [
  { id: "github", kind: "builtin", displayName: "GitHub", baseUrl: "https://api.github.com" },
  { id: "linear", kind: "builtin", displayName: "Linear", baseUrl: undefined },
]

const populatedLoaderData = {
  platforms,
  connectionCounts: { github: 2 }, // Linear has 0 connections
}

// ---- Mocks ------------------------------------------------------------------

const mockUseLoaderData = vi.fn().mockReturnValue(emptyLoaderData)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
}))

// Loader calls both getPlatforms and getCredentials — stub both.
vi.mock("../server/data.functions.js", () => ({
  getPlatforms: vi.fn(),
  getCredentials: vi.fn(),
}))

const { Route } = await import("./platforms.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — typing the internal options shape is not worth the boilerplate
const PlatformsPage = (Route as any).options.component as React.FC

// ---- Tests ------------------------------------------------------------------

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
})

describe("PlatformsPage", () => {
  it("renders the page heading", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    const { getByRole } = render(<PlatformsPage />)
    expect(getByRole("heading", { name: "Platforms" })).toBeInTheDocument()
  })

  it("shows empty state when no platforms", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    const { getByText } = render(<PlatformsPage />)
    expect(getByText("No platforms yet.")).toBeInTheDocument()
  })

  it("renders the platforms table when populated", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { getByRole } = render(<PlatformsPage />)
    expect(getByRole("table")).toBeInTheDocument()
  })

  it("renders platform display names", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { getByText } = render(<PlatformsPage />)
    expect(getByText("GitHub")).toBeInTheDocument()
    expect(getByText("Linear")).toBeInTheDocument()
  })

  it("renders a dash for platforms with no base URL", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { getByText } = render(<PlatformsPage />)
    // Linear has no baseUrl → renders the em-dash placeholder
    expect(getByText("—")).toBeInTheDocument()
  })

  it("renders connection count from credentials (0 for unconnected platforms)", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { getAllByText } = render(<PlatformsPage />)
    // GitHub has 2 connections; Linear has 0 — both rendered in tabular-nums mono
    expect(getAllByText("2").length).toBeGreaterThanOrEqual(1)
    expect(getAllByText("0").length).toBeGreaterThanOrEqual(1)
  })
})
