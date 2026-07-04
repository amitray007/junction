// SPDX-License-Identifier: AGPL-3.0-only
// Route test for /app/:id — the per-app connections page (increment 30).
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.
//
// happy-dom limitation (documented in -credentials.test.tsx / -platforms.test.tsx):
// Radix DropdownMenu uses a Portal + pointer events for opening — fireEvent.click
// on the trigger does NOT render the portal content in happy-dom. So the ⋯ row
// menu's trigger presence/attributes are verified here; the full open→choose
// path is covered by the junction-web-verify browser pass (real Chromium).

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectionMeta } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

const githubApp = {
  id: "github",
  displayName: "GitHub",
  supportedKinds: ["mcp", "cli", "openapi", "graphql"],
  auth: [{ mode: "oauth2" as const, providerId: "github" }, { mode: "token" as const }],
}

const spotifyApp = {
  id: "spotify",
  displayName: "Spotify",
  supportedKinds: [] as string[],
  auth: [{ mode: "oauth2" as const, providerId: "spotify" }],
}

const otherAppDisplay = {
  id: "other",
  displayName: "Other",
  supportedKinds: [] as string[],
}

const emptyLoaderData = { app: githubApp, connections: [] as ConnectionMeta[] }

const oauthConnection: ConnectionMeta = {
  credentialId: "cred-1",
  account: "work",
  platformId: "github",
  platformDisplayName: "GitHub",
  kind: "openapi",
  oauthState: {
    providerId: "github",
    expiresAt: "2026-01-01T00:00:00.000Z",
    needsReauth: false,
    hasRefreshToken: true,
  },
}

const needsReauthConnection: ConnectionMeta = {
  credentialId: "cred-2",
  account: "personal",
  platformId: "github",
  platformDisplayName: "GitHub",
  kind: "openapi",
  oauthState: {
    providerId: "github",
    expiresAt: "2026-01-01T00:00:00.000Z",
    needsReauth: true,
    hasRefreshToken: false,
  },
}

const bearerConnection: ConnectionMeta = {
  credentialId: "cred-3",
  account: "token-account",
  platformId: "github",
  platformDisplayName: "GitHub",
  kind: "cli",
  lastVerifyResult: "ok",
}

const publicConnection: ConnectionMeta = {
  account: "—",
  platformId: "github",
  platformDisplayName: "GitHub (public)",
  kind: "mcp",
}

const populatedLoaderData = { app: githubApp, connections: [oauthConnection] }
const emptySpotifyLoaderData = { app: spotifyApp, connections: [] as ConnectionMeta[] }
const otherLoaderData = { app: otherAppDisplay, connections: [publicConnection] }

// ---- Mocks ------------------------------------------------------------------

const mockUseLoaderData = vi.fn().mockReturnValue(emptyLoaderData)
const mockInvalidate = vi.fn().mockResolvedValue(undefined)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  useRouter: () => ({ invalidate: mockInvalidate }),
  notFound: () => new Error("notFound"),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

vi.mock("../server/data.functions.js", () => ({
  getApps: vi.fn(),
}))

const mockTestCredentialFn = vi.fn()
const mockRotateCredentialFn = vi.fn()
const mockRenameCredentialFn = vi.fn()
const mockRemoveCredentialFn = vi.fn()

vi.mock("../server/mutations.functions.js", () => ({
  testCredentialFn: (...args: unknown[]) => mockTestCredentialFn(...args),
  rotateCredentialFn: (...args: unknown[]) => mockRotateCredentialFn(...args),
  renameCredentialFn: (...args: unknown[]) => mockRenameCredentialFn(...args),
  removeCredentialFn: (...args: unknown[]) => mockRemoveCredentialFn(...args),
}))

const mockStartReconnectFn = vi.fn()
vi.mock("../server/oauth-connect.functions.js", () => ({
  startReconnectFn: (...args: unknown[]) => mockStartReconnectFn(...args),
}))

const { Route } = await import("./app.$id.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — internal options shape
const AppDetailPage = (Route as any).options.component as React.FC

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
  mockTestCredentialFn.mockReset()
  mockRotateCredentialFn.mockReset()
  mockRenameCredentialFn.mockReset()
  mockRemoveCredentialFn.mockReset()
  mockStartReconnectFn.mockReset()
  mockInvalidate.mockReset().mockResolvedValue(undefined)
})

describe("AppDetailPage", () => {
  // ── Landmark ────────────────────────────────────────────────────────────

  it("renders the app displayName as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("heading", { level: 1, name: "GitHub" })).toBeInTheDocument()
  })

  // ── Empty state — the catalog CTA ──────────────────────────────────────

  it("shows the empty-state catalog CTA with supportedKinds when there are no connections", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText(/no connections to github yet/i)).toBeInTheDocument()
    expect(screen.getByText(/mcp, cli, openapi, graphql/i)).toBeInTheDocument()
  })

  it("shows Connect (OAuth) and Add Credential CTAs matching the app's auth modes", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("link", { name: /connect \(oauth\)/i })).toHaveAttribute(
      "href",
      "/credentials",
    )
    expect(screen.getByRole("link", { name: /add credential/i })).toHaveAttribute(
      "href",
      "/credentials",
    )
  })

  it("handles an OAuth-only app with no supportedKinds gracefully (e.g. Spotify)", () => {
    mockUseLoaderData.mockReturnValue(emptySpotifyLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("heading", { level: 1, name: "Spotify" })).toBeInTheDocument()
    expect(screen.getByText(/no connections to spotify yet/i)).toBeInTheDocument()
    // No supportedKinds hint line for an OAuth-only app.
    expect(screen.queryByText(/junction can stand up:/i)).not.toBeInTheDocument()
  })

  // ── Populated state — list of connections ──────────────────────────────

  it("lists connections with account, vertical, platform, and a status badge", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText("work")).toBeInTheDocument()
    expect(screen.getByText(/via openapi/i)).toBeInTheDocument()
    expect(screen.getByText("Connected")).toBeInTheDocument()
  })

  it("shows a Reconnect-relevant Auth Failed badge for a needsReauth connection", () => {
    mockUseLoaderData.mockReturnValue({ app: githubApp, connections: [needsReauthConnection] })
    render(<AppDetailPage />)
    expect(screen.getByText("Auth Failed")).toBeInTheDocument()
  })

  it("shows a No Auth badge for a public/credential-less connection", () => {
    mockUseLoaderData.mockReturnValue(otherLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText("No Auth")).toBeInTheDocument()
  })

  it("renders the 'Other' synthetic group with its fixed label, not via getApp", () => {
    mockUseLoaderData.mockReturnValue(otherLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("heading", { level: 1, name: "Other" })).toBeInTheDocument()
  })

  it("shows a Connect account action when there are existing connections", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("link", { name: /connect account/i })).toHaveAttribute(
      "href",
      "/credentials",
    )
  })

  it("does not show the row ⋯ menu for a credential-less (public) connection", () => {
    mockUseLoaderData.mockReturnValue(otherLoaderData)
    render(<AppDetailPage />)
    expect(screen.queryByRole("button", { name: /row actions/i })).not.toBeInTheDocument()
  })

  // ── ⋯ menu exposes the shipped lifecycle actions (structure, not open-state —
  // Radix portal limitation documented above) ────────────────────────────────

  it("renders a row actions trigger for a connection with a real credential", () => {
    mockUseLoaderData.mockReturnValue({
      app: githubApp,
      connections: [oauthConnection, bearerConnection],
    })
    render(<AppDetailPage />)
    const triggers = screen.getAllByRole("button", { name: /row actions/i })
    expect(triggers).toHaveLength(2)
  })
})
