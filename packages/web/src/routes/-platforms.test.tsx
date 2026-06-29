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
  connectionCounts: { github: 2 }, // Linear has 0 connections (absent key → 0)
}

// Zero-connections fixture — all platforms present but no credentials yet.
const zeroConnectionsData = {
  platforms,
  connectionCounts: {},
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
  // ── Landmark + heading ─────────────────────────────────────────────────────

  it("renders the page heading as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    const { getByRole } = render(<PlatformsPage />)
    expect(getByRole("heading", { level: 1, name: "Platforms" })).toBeInTheDocument()
  })

  // ── Empty state ────────────────────────────────────────────────────────────

  it("shows empty state when no platforms", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    const { getByText } = render(<PlatformsPage />)
    expect(getByText("No platforms yet.")).toBeInTheDocument()
  })

  // ── Table rendering ────────────────────────────────────────────────────────

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

  it("renders connection count from credentials — scoped to the GitHub row", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { getByRole } = render(<PlatformsPage />)
    const table = getByRole("table")
    // GitHub row: first data row contains "GitHub" and the count "2"
    const rows = table.querySelectorAll("tbody tr")
    const githubRow = Array.from(rows).find((r) => r.textContent?.includes("GitHub"))
    expect(githubRow).toBeDefined()
    expect(githubRow?.textContent).toContain("2")
  })

  it("renders 0 connections for a platform with no credentials (absent key in connectionCounts)", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { getByRole } = render(<PlatformsPage />)
    const table = getByRole("table")
    const rows = table.querySelectorAll("tbody tr")
    const linearRow = Array.from(rows).find((r) => r.textContent?.includes("Linear"))
    expect(linearRow).toBeDefined()
    expect(linearRow?.textContent).toContain("0")
  })

  it("renders 0 for all platforms when connectionCounts is empty", () => {
    mockUseLoaderData.mockReturnValue(zeroConnectionsData)
    const { getByRole } = render(<PlatformsPage />)
    const table = getByRole("table")
    const rows = Array.from(table.querySelectorAll("tbody tr"))
    // Every data row must show 0 when there are no credentials
    for (const row of rows) {
      expect(row.textContent).toContain("0")
    }
  })
})
