// SPDX-License-Identifier: AGPL-3.0-only
// Route test for /app (index) — the Apps browse-catalog page (increment 30).
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component. Mirrors
// -platforms.test.tsx's mocking pattern.

import { cleanup, render, screen } from "@testing-library/react"
import type React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppGroupMeta, AppMeta } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

const catalog: AppMeta[] = [
  {
    id: "github",
    displayName: "GitHub",
    supportedKinds: ["mcp", "cli", "openapi", "graphql"],
    auth: [{ mode: "oauth2", providerId: "github" }, { mode: "token" }],
  },
  {
    id: "spotify",
    displayName: "Spotify",
    supportedKinds: [],
    auth: [{ mode: "oauth2", providerId: "spotify" }],
  },
]

const emptyLoaderData = { catalog: [] as AppMeta[], groups: [] as AppGroupMeta[] }

const populatedLoaderData = {
  catalog,
  groups: [
    {
      appId: "github",
      connections: [
        {
          credentialId: "cred-1",
          account: "work",
          platformId: "github",
          platformDisplayName: "GitHub",
          kind: "openapi",
        },
      ],
    },
  ] as AppGroupMeta[],
}

const withOtherLoaderData = {
  catalog,
  groups: [
    ...populatedLoaderData.groups,
    {
      appId: "other",
      connections: [
        {
          credentialId: "cred-2",
          account: "solo",
          platformId: "mystery-thing",
          platformDisplayName: "Mystery Thing",
          kind: "cli",
        },
      ],
    },
  ] as AppGroupMeta[],
}

// ---- Mocks ------------------------------------------------------------------

const mockUseLoaderData = vi.fn().mockReturnValue(emptyLoaderData)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string
    params?: Record<string, string>
    children: React.ReactNode
  }) => {
    const href = params ? to.replace(/\$(\w+)/g, (_, key: string) => params[key] ?? "") : to
    return (
      <a href={href} {...props}>
        {children}
      </a>
    )
  },
}))

vi.mock("../server/data.functions.js", () => ({
  getApps: vi.fn(),
}))

const { Route } = await import("./app.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — internal options shape
const AppsIndexPage = (Route as any).options.component as React.FC

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
})

describe("AppsIndexPage", () => {
  it("renders the page heading as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByRole("heading", { level: 1, name: "Apps" })).toBeInTheDocument()
  })

  it("shows an empty state when the catalog has no apps", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByText(/no apps in the catalog yet/i)).toBeInTheDocument()
  })

  it("renders every catalog app, including unconnected ones", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    expect(screen.getByText("Spotify")).toBeInTheDocument()
  })

  it("shows a connected count for an app with connections, and Available for one with none", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByText("1 connected")).toBeInTheDocument()
    expect(screen.getByText("Available")).toBeInTheDocument()
  })

  it("links each app card to /app/:id", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    const githubLink = screen.getByText("GitHub").closest("a")
    expect(githubLink).toHaveAttribute("href", "/app/github")
  })

  it("renders a synthetic Other card only when a connection attributes to 'other'", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { rerender } = render(<AppsIndexPage />)
    expect(screen.queryByText("Other")).not.toBeInTheDocument()

    mockUseLoaderData.mockReturnValue(withOtherLoaderData)
    rerender(<AppsIndexPage />)
    expect(screen.getByText("Other")).toBeInTheDocument()
    const otherLink = screen.getByText("Other").closest("a")
    expect(otherLink).toHaveAttribute("href", "/app/other")
  })

  it("shows the OAuth-only note for an app with no supportedKinds", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByText(/oauth-only/i)).toBeInTheDocument()
  })
})
