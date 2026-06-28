// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /platforms.
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PlatformMeta } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

const emptyData: PlatformMeta[] = []

const populatedData: PlatformMeta[] = [
  { id: "github", kind: "builtin", displayName: "GitHub", baseUrl: "https://api.github.com" },
  { id: "linear", kind: "builtin", displayName: "Linear", baseUrl: undefined },
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
  getPlatforms: vi.fn(),
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
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<PlatformsPage />)
    expect(getByRole("heading", { name: "Platforms" })).toBeInTheDocument()
  })

  it("shows empty state when no platforms", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByText } = render(<PlatformsPage />)
    expect(getByText("No platforms yet.")).toBeInTheDocument()
  })

  it("renders the platforms table when populated", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByRole } = render(<PlatformsPage />)
    expect(getByRole("table")).toBeInTheDocument()
  })

  it("renders platform display names", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByText } = render(<PlatformsPage />)
    expect(getByText("GitHub")).toBeInTheDocument()
    expect(getByText("Linear")).toBeInTheDocument()
  })

  it("renders a dash for platforms with no base URL", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByText } = render(<PlatformsPage />)
    // Linear has no baseUrl → renders the em-dash placeholder
    expect(getByText("—")).toBeInTheDocument()
  })
})
