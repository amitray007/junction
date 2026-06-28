// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /credentials.
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CredentialMeta } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

const emptyData: CredentialMeta[] = []

const populatedData: CredentialMeta[] = [
  { id: "cred-1", platformId: "github", account: "alice", kind: "api-key" },
  { id: "cred-2", platformId: "linear", account: "alice", kind: "oauth2" },
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
  getCredentials: vi.fn(),
}))

const { Route } = await import("./credentials.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — typing the internal options shape is not worth the boilerplate
const CredentialsPage = (Route as any).options.component as React.FC

// ---- Tests ------------------------------------------------------------------

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
})

describe("CredentialsPage", () => {
  it("renders the page heading", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<CredentialsPage />)
    expect(getByRole("heading", { name: "Credentials" })).toBeInTheDocument()
  })

  it("shows empty state when no credentials", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByText } = render(<CredentialsPage />)
    expect(getByText("No credentials yet.")).toBeInTheDocument()
  })

  it("renders the credentials table when populated", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByRole } = render(<CredentialsPage />)
    expect(getByRole("table")).toBeInTheDocument()
  })

  it("renders a row per credential with platform and account", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getAllByText } = render(<CredentialsPage />)
    // Two rows share the same account name → use getAllByText
    expect(getAllByText("alice").length).toBe(populatedData.length)
    expect(getAllByText("github").length).toBeGreaterThanOrEqual(1)
  })

  it("renders 'Configured' status badge (never 'Connected') for all credential kinds", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getAllByText } = render(<CredentialsPage />)
    // kindToStatus always returns "configured" — both rows show "Configured"
    expect(getAllByText("Configured").length).toBe(populatedData.length)
    // "Connected" must NOT appear (it would be a liveness overstatement)
    const { queryAllByText } = render(<CredentialsPage />)
    expect(queryAllByText("Connected").length).toBe(0)
  })
})
