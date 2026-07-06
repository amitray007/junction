// SPDX-License-Identifier: AGPL-3.0-only
// Route test for /app/:id — the surface-first per-app capability view
// (increment 30.10). Strategy: mock createFileRoute so Route.useLoaderData()
// returns test fixtures, then import the module and render
// Route.options.component.
//
// happy-dom limitation (documented in -credentials.test.tsx / -platforms.test.tsx):
// Radix DropdownMenu uses a Portal + pointer events for opening — fireEvent.click
// on the trigger does NOT render the portal content in happy-dom. So the ⋯ row
// menu's trigger presence/attributes are verified here; the full open→choose
// path is covered by the junction-web-verify browser pass (real Chromium).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppDetail, ConnectionMeta, SurfaceView } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

const githubApp = { id: "github", displayName: "GitHub" }
const spotifyApp = { id: "spotify", displayName: "Spotify" }
const otherAppDisplay = { id: "other", displayName: "Other" }

const oauthConnection: ConnectionMeta = {
  credentialId: "cred-1",
  account: "work",
  platformId: "github-openapi",
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
  platformId: "github-openapi",
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
  platformId: "github-cli",
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

// A surface with the OAuth connection, tools returned (serving).
const openapiSurfaceServing: SurfaceView = {
  kind: "openapi",
  displayName: "REST API",
  auth: [{ mode: "oauth2", providerId: "github" }, { mode: "token" }],
  state: "serving",
  connections: [
    {
      ...oauthConnection,
      tools: {
        status: "ok",
        tools: [
          { namespaced: "getUser", raw: "getUser", description: "Get a user", params: "id*" },
        ],
      },
    },
  ],
}

// The http surface with no tools — the honest "no tools available" fixture.
const httpSurfaceEmpty: SurfaceView = {
  kind: "http",
  displayName: "Custom REST request",
  auth: [{ mode: "token" }],
  state: "available",
  connections: [],
}

// A surface whose probe errored.
const cliSurfaceError: SurfaceView = {
  kind: "cli",
  displayName: "gh CLI",
  auth: [{ mode: "token" }],
  state: "connected",
  connections: [
    {
      ...bearerConnection,
      tools: { status: "error", reason: "binary not found" },
    },
  ],
}

// ── Connect (increment 30.11) fixtures — unconnected, connectable surfaces ──

const connectableTokenSurface: SurfaceView = {
  kind: "openapi",
  displayName: "REST API",
  auth: [{ mode: "oauth2", providerId: "github" }, { mode: "token" }],
  state: "available",
  connections: [],
  connectable: { authModes: ["oauth2", "token"], verifiable: true },
}

const connectableHttpSurface: SurfaceView = {
  kind: "http",
  displayName: "Custom REST request",
  auth: [{ mode: "token" }],
  state: "available",
  connections: [],
  connectable: { authModes: ["token"], verifiable: false },
}

const connectableLoaderData: AppDetail = {
  app: githubApp,
  surfaces: [connectableTokenSurface],
  otherConnections: [],
}

const connectableHttpLoaderData: AppDetail = {
  app: githubApp,
  surfaces: [connectableHttpSurface],
  otherConnections: [],
}

const emptyLoaderData: AppDetail = { app: githubApp, surfaces: [], otherConnections: [] }
const emptySpotifyLoaderData: AppDetail = { app: spotifyApp, surfaces: [], otherConnections: [] }
const otherLoaderData: AppDetail = {
  app: otherAppDisplay,
  surfaces: [],
  otherConnections: [publicConnection],
}
const surfacesLoaderData: AppDetail = {
  app: githubApp,
  surfaces: [openapiSurfaceServing, httpSurfaceEmpty],
  otherConnections: [],
}
const errorSurfaceLoaderData: AppDetail = {
  app: githubApp,
  surfaces: [cliSurfaceError],
  otherConnections: [],
}
const needsReauthLoaderData: AppDetail = {
  app: githubApp,
  surfaces: [
    {
      kind: "openapi",
      displayName: "REST API",
      auth: [{ mode: "oauth2", providerId: "github" }],
      state: "connected",
      connections: [{ ...needsReauthConnection, tools: { status: "ok", tools: [] } }],
    },
  ],
  otherConnections: [],
}

// ---- Mocks ------------------------------------------------------------------

const mockUseLoaderData = vi.fn().mockReturnValue(emptyLoaderData)
const mockInvalidate = vi.fn().mockResolvedValue(undefined)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  useRouter: () => ({ invalidate: mockInvalidate }),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

vi.mock("../server/data.functions.js", () => ({
  getAppDetail: vi.fn(),
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

const mockConnectSurfaceFn = vi.fn()
vi.mock("../server/connect.functions.js", () => ({
  connectSurfaceFn: (...args: unknown[]) => mockConnectSurfaceFn(...args),
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
  mockConnectSurfaceFn.mockReset()
  mockInvalidate.mockReset().mockResolvedValue(undefined)
})

describe("AppDetailPage", () => {
  // ── Landmark ────────────────────────────────────────────────────────────

  it("renders the app displayName as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("heading", { level: 1, name: "GitHub" })).toBeInTheDocument()
  })

  // ── Empty state — the thin-app catalog CTA fallback (§2 item 4) ────────

  it("shows the empty-state catalog CTA when there are no surfaces and no connections", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText(/no connections to github yet/i)).toBeInTheDocument()
  })

  it("handles a thin app with no surfaces gracefully (e.g. Spotify)", () => {
    mockUseLoaderData.mockReturnValue(emptySpotifyLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("heading", { level: 1, name: "Spotify" })).toBeInTheDocument()
    expect(screen.getByText(/no connections to spotify yet/i)).toBeInTheDocument()
  })

  it("renders the 'Other' synthetic group with its fixed label", () => {
    mockUseLoaderData.mockReturnValue(otherLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("heading", { level: 1, name: "Other" })).toBeInTheDocument()
    expect(screen.getByText("No Auth")).toBeInTheDocument()
  })

  // ── Surface-first rendering ─────────────────────────────────────────────

  it("shows the surface-count subtitle (N surfaces · M connected)", () => {
    mockUseLoaderData.mockReturnValue(surfacesLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText("2 surfaces · 1 connected")).toBeInTheDocument()
  })

  it("renders a surface card per catalog surface, all equally (kind tag + displayName + state)", () => {
    mockUseLoaderData.mockReturnValue(surfacesLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText("openapi")).toBeInTheDocument()
    expect(screen.getByText("REST API")).toBeInTheDocument()
    expect(screen.getByText("http")).toBeInTheDocument()
    expect(screen.getByText("Custom REST request")).toBeInTheDocument()
  })

  it("tools-list rendering: shows the tool name, description, and params summary", () => {
    mockUseLoaderData.mockReturnValue(surfacesLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText("getUser")).toBeInTheDocument()
    expect(screen.getByText("Get a user")).toBeInTheDocument()
    expect(screen.getByText("id*")).toBeInTheDocument()
  })

  it("honest-empty rendering: a probe-ok-but-empty surface shows 'No tools available'", () => {
    mockUseLoaderData.mockReturnValue(surfacesLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText("No tools available.")).toBeInTheDocument()
  })

  it("probe-error rendering is DISTINCT from the honest-empty state — 'Couldn't list tools'", () => {
    mockUseLoaderData.mockReturnValue(errorSurfaceLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText(/couldn't list tools — binary not found/i)).toBeInTheDocument()
    expect(screen.queryByText("No tools available.")).not.toBeInTheDocument()
    // Rendered via role="alert" — distinguishable in the a11y tree, not just visually.
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("shows a Reconnect-relevant Auth Failed badge for a needsReauth connection under its surface", () => {
    mockUseLoaderData.mockReturnValue(needsReauthLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText("Auth Failed")).toBeInTheDocument()
  })

  it("does not show the row ⋯ menu for a credential-less (public) connection", () => {
    mockUseLoaderData.mockReturnValue(otherLoaderData)
    render(<AppDetailPage />)
    expect(screen.queryByRole("button", { name: /row actions/i })).not.toBeInTheDocument()
  })

  it("renders a row actions trigger for a connection with a real credential", () => {
    mockUseLoaderData.mockReturnValue(errorSurfaceLoaderData)
    render(<AppDetailPage />)
    expect(screen.getAllByRole("button", { name: /row actions/i })).toHaveLength(1)
  })

  it("shows a Connect account action when there are existing connections", () => {
    mockUseLoaderData.mockReturnValue(surfacesLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("link", { name: /connect account/i })).toHaveAttribute(
      "href",
      "/credentials",
    )
  })

  // ── Review fix: duplicate React key (same-kind surfaces, 30.12 territory) ──
  // Locks the key contract — `key={surface.kind}` alone would collide for two
  // same-kind surfaces (latent today per intersectSurfaces' LIMITATION), so
  // both must still render distinctly with an index-suffixed key.

  it("renders BOTH surfaces when the DTO has two same-kind entries (defensive key fix)", () => {
    const duplicateKindLoaderData: AppDetail = {
      app: githubApp,
      surfaces: [
        {
          kind: "http",
          displayName: "First HTTP Surface",
          auth: [{ mode: "token" }],
          state: "available",
          connections: [],
        },
        {
          kind: "http",
          displayName: "Second HTTP Surface",
          auth: [{ mode: "token" }],
          state: "available",
          connections: [],
        },
      ],
      otherConnections: [],
    }
    mockUseLoaderData.mockReturnValue(duplicateKindLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByText("First HTTP Surface")).toBeInTheDocument()
    expect(screen.getByText("Second HTTP Surface")).toBeInTheDocument()
  })

  // ── Connect (increment 30.11) ───────────────────────────────────────────

  describe("Connect surface dialog", () => {
    it("renders the Connect button on an unconnected, connectable surface", () => {
      mockUseLoaderData.mockReturnValue(connectableLoaderData)
      render(<AppDetailPage />)
      expect(screen.getByRole("button", { name: /connect github · rest api/i })).toBeInTheDocument()
    })

    it("does not render a Connect button once the surface has a connection", () => {
      mockUseLoaderData.mockReturnValue(surfacesLoaderData) // openapiSurfaceServing has 1 connection
      render(<AppDetailPage />)
      expect(
        screen.queryByRole("button", { name: /connect github · rest api/i }),
      ).not.toBeInTheDocument()
    })

    it("shows an auth-mode select for a multi-mode surface, defaulting to the oauth2 deep-link note", async () => {
      mockUseLoaderData.mockReturnValue(connectableLoaderData)
      const { getByRole, queryByLabelText } = render(<AppDetailPage />)
      fireEvent.click(getByRole("button", { name: /connect github · rest api/i }))
      await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument())

      // Multi-mode surface (oauth2 + token) → the auth-mode Select renders.
      expect(getByRole("combobox", { name: /auth mode/i })).toBeInTheDocument()
      // Default mode is oauth2 (the surface's authored preference, auth[0]) →
      // the deep-link note shows, NOT the account/secret fields (§2c).
      expect(
        screen.getByText(/github uses oauth — register an oauth app on the credentials page/i),
      ).toBeInTheDocument()
      expect(queryByLabelText("Account")).not.toBeInTheDocument()
      expect(queryByLabelText("Secret")).not.toBeInTheDocument()
    })

    it("shows the not-verifiable honesty note for a non-verifiable, single-mode surface (no auth-mode select)", async () => {
      mockUseLoaderData.mockReturnValue(connectableHttpLoaderData)
      const { getByRole, queryByLabelText } = render(<AppDetailPage />)
      fireEvent.click(getByRole("button", { name: /connect github · custom rest request/i }))
      await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument())

      // Single offered mode ("token") → no auth-mode Select rendered.
      expect(queryByLabelText("Auth mode")).not.toBeInTheDocument()
      expect(
        screen.getByText(/junction can't automatically verify this surface/i),
      ).toBeInTheDocument()
    })

    it("disables Confirm until the secret is non-empty", async () => {
      mockUseLoaderData.mockReturnValue(connectableHttpLoaderData)
      const { getByRole, getByLabelText } = render(<AppDetailPage />)
      fireEvent.click(getByRole("button", { name: /connect github · custom rest request/i }))
      await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument())

      const confirmBtn = getByRole("button", { name: /^connect$/i })
      expect(confirmBtn).toBeDisabled()

      fireEvent.change(getByLabelText("Secret"), { target: { value: "a-token" } })
      expect(confirmBtn).not.toBeDisabled()
    })

    it("keeps the dialog open with the auth-failed copy on a verifyFailed:auth-failed result", async () => {
      mockConnectSurfaceFn.mockResolvedValue({ verifyFailed: "auth-failed" })
      mockUseLoaderData.mockReturnValue(connectableHttpLoaderData)
      const { getByRole, getByLabelText } = render(<AppDetailPage />)
      fireEvent.click(getByRole("button", { name: /connect github · custom rest request/i }))
      await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument())

      fireEvent.change(getByLabelText("Secret"), { target: { value: "bad-token" } })
      fireEvent.click(getByRole("button", { name: /^connect$/i }))

      await waitFor(() => {
        expect(
          screen.getByText(/couldn't verify — authentication failed\. check the token\./i),
        ).toBeInTheDocument()
      })
      expect(getByRole("dialog")).toBeInTheDocument()
    })

    it("keeps the dialog open with the unreachable copy on a verifyFailed:unreachable result", async () => {
      mockConnectSurfaceFn.mockResolvedValue({ verifyFailed: "unreachable" })
      mockUseLoaderData.mockReturnValue(connectableHttpLoaderData)
      const { getByRole, getByLabelText } = render(<AppDetailPage />)
      fireEvent.click(getByRole("button", { name: /connect github · custom rest request/i }))
      await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument())

      fireEvent.change(getByLabelText("Secret"), { target: { value: "some-token" } })
      fireEvent.click(getByRole("button", { name: /^connect$/i }))

      await waitFor(() => {
        expect(
          screen.getByText(
            /couldn't reach this surface — this may be a catalog\/base-url issue, not your token\./i,
          ),
        ).toBeInTheDocument()
      })
      expect(getByRole("dialog")).toBeInTheDocument()
    })

    it("surfaces the platform-kind-conflict message on a conflict result", async () => {
      mockConnectSurfaceFn.mockResolvedValue({ conflict: { existingKind: "openapi" } })
      mockUseLoaderData.mockReturnValue(connectableHttpLoaderData)
      const { getByRole, getByLabelText } = render(<AppDetailPage />)
      fireEvent.click(getByRole("button", { name: /connect github · custom rest request/i }))
      await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument())

      fireEvent.change(getByLabelText("Secret"), { target: { value: "some-token" } })
      fireEvent.click(getByRole("button", { name: /^connect$/i }))

      await waitFor(() => {
        expect(screen.getByText(/a openapi platform already uses this id/i)).toBeInTheDocument()
      })
      expect(getByRole("dialog")).toBeInTheDocument()
    })
  })

  // ── Landmark (repeat, per web.md's per-route requirement) ────────────────

  it("has a <main>-reachable heading landmark for the connectable-surface fixture too", () => {
    mockUseLoaderData.mockReturnValue(connectableLoaderData)
    render(<AppDetailPage />)
    expect(screen.getByRole("heading", { level: 1, name: "GitHub" })).toBeInTheDocument()
  })
})
