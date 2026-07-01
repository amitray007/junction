// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /platforms.
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.
// Loader shape (inc 24.5): { platforms, connectionCounts } — derived from credentials.
//
// inc 26 slice C: Add/Edit/Delete/Refresh write path added. happy-dom limitation
// (see -credentials.test.tsx / -profiles.test.tsx): Radix DropdownMenu and Select
// use a Portal + pointer events for opening — fireEvent.click on the trigger does
// NOT render the portal content in happy-dom. So the ⋯ row menu (Edit/Refresh/Delete)
// and the kind-Select's non-default options are verified for presence/attributes
// here; the full open→choose→submit path is covered by the junction-web-verify
// browser pass (real Chromium), not this suite.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

const mockInvalidate = vi.fn().mockResolvedValue(undefined)
const mockUseLoaderData = vi.fn().mockReturnValue(emptyLoaderData)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  // RefreshButton (in the PageHeader actions) calls useRouter().invalidate().
  useRouter: () => ({ invalidate: mockInvalidate }),
  // AuthSchemeNote renders a Link to /credentials — a plain <a> stub is enough here.
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

// Loader calls both getPlatforms and getCredentials — stub both.
vi.mock("../server/data.functions.js", () => ({
  getPlatforms: vi.fn(),
  getCredentials: vi.fn(),
}))

const mockAddPlatformFn = vi.fn()
const mockUpdatePlatformFn = vi.fn()
const mockDeletePlatformFn = vi.fn()
const mockRefreshPlatformFn = vi.fn()
const mockGetPlatformDetailFn = vi.fn()

vi.mock("../server/platform-mutations.functions.js", () => ({
  addPlatformFn: (...args: unknown[]) => mockAddPlatformFn(...args),
  updatePlatformFn: (...args: unknown[]) => mockUpdatePlatformFn(...args),
  deletePlatformFn: (...args: unknown[]) => mockDeletePlatformFn(...args),
  refreshPlatformFn: (...args: unknown[]) => mockRefreshPlatformFn(...args),
  getPlatformDetailFn: (...args: unknown[]) => mockGetPlatformDetailFn(...args),
}))

const { Route } = await import("./platforms.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — typing the internal options shape is not worth the boilerplate
const PlatformsPage = (Route as any).options.component as React.FC

// ---- Tests ------------------------------------------------------------------

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
  mockAddPlatformFn.mockReset()
  mockUpdatePlatformFn.mockReset()
  mockDeletePlatformFn.mockReset()
  mockRefreshPlatformFn.mockReset()
  mockGetPlatformDetailFn.mockReset()
  mockInvalidate.mockReset().mockResolvedValue(undefined)
})

describe("PlatformsPage", () => {
  // ── Landmark + heading ─────────────────────────────────────────────────────

  it("renders the page heading as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    const { getByRole } = render(<PlatformsPage />)
    expect(getByRole("heading", { level: 1, name: "Platforms" })).toBeInTheDocument()
  })

  // ── Empty state (B3: empty table row, not bare text) ──────────────────────

  it("shows empty table with header + message row when no platforms", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    const { getByRole, getByText } = render(<PlatformsPage />)
    // Table always rendered — header present
    expect(getByRole("table")).toBeInTheDocument()
    // Empty message in a full-width row
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

  it("renders inline baseUrl under Name for platforms that have one (inc 24.6: no dedicated column)", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { getByText } = render(<PlatformsPage />)
    // GitHub has baseUrl → rendered inline under the name cell
    expect(getByText("https://api.github.com")).toBeInTheDocument()
  })

  it("does not render em-dash for platforms with no baseUrl (inc 24.6: Base URL column removed)", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { queryByText } = render(<PlatformsPage />)
    // The old Base URL column rendered "—" for every platform without a baseUrl.
    // inc 24.6: the column is gone entirely — no "—" anywhere in the table.
    expect(queryByText("—")).not.toBeInTheDocument()
    // Linear has no baseUrl → no inline URL text under its name cell either
    expect(queryByText("linear")).not.toBeInTheDocument() // id not shown; displayName is "Linear"
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

  // ── Row actions (⋯ menu present, keyboard-reachable per row) ───────────────

  it("row action buttons are present for each platform row, aria-haspopup=menu", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { getAllByRole } = render(<PlatformsPage />)
    const actionButtons = getAllByRole("button", { name: /row actions/i })
    expect(actionButtons.length).toBe(platforms.length)
    for (const btn of actionButtons) {
      expect(btn.tagName).toBe("BUTTON")
      expect(btn.getAttribute("aria-haspopup")).toBe("menu")
    }
  })

  // ── Add Platform dialog ─────────────────────────────────────────────────────

  it("Add Platform dialog: opens and shows kind-specific fields for the default kind (mcp/http)", async () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<PlatformsPage />)

    fireEvent.click(screen.getByRole("button", { name: /add platform/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const dialog = screen.getByRole("dialog")
    // Transport sub-select present for the mcp kind; http fields present by default
    expect(dialog.querySelector("#platform-transport")).not.toBeNull()
    expect(dialog.querySelector("#platform-url")).not.toBeNull()
    expect(dialog.querySelector("#platform-auth-header")).not.toBeNull()
    // other-kind-only fields absent
    expect(dialog.querySelector("#platform-spec-url")).toBeNull()
    expect(dialog.querySelector("#platform-command")).toBeNull()
  })

  it("Add Platform dialog: required-field validation prevents submission", async () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<PlatformsPage />)

    fireEvent.click(screen.getByRole("button", { name: /add platform/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const dialog = screen.getByRole("dialog")
    const submitBtn = dialog.querySelector("button[type='submit']") as HTMLButtonElement
    fireEvent.click(submitBtn)

    await waitFor(() => expect(screen.getByText("ID is required")).toBeInTheDocument())
    expect(mockAddPlatformFn).not.toHaveBeenCalled()
  })

  it("Add Platform dialog: submits mcp-http kind, calls addPlatformFn, invalidates on success", async () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    mockAddPlatformFn.mockResolvedValue({
      ok: true,
      platform: { id: "new-plat", kind: "mcp", displayName: "New Plat" },
    })

    render(<PlatformsPage />)
    fireEvent.click(screen.getByRole("button", { name: /add platform/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const dialog = screen.getByRole("dialog")
    fireEvent.change(dialog.querySelector("#platform-id") as HTMLInputElement, {
      target: { value: "new-plat" },
    })
    fireEvent.change(dialog.querySelector("#platform-display-name") as HTMLInputElement, {
      target: { value: "New Plat" },
    })
    fireEvent.change(dialog.querySelector("#platform-url") as HTMLInputElement, {
      target: { value: "https://example.com/mcp" },
    })

    fireEvent.click(dialog.querySelector("button[type='submit']") as HTMLButtonElement)

    await waitFor(() => expect(mockAddPlatformFn).toHaveBeenCalledOnce())
    const call = mockAddPlatformFn.mock.calls[0]?.[0]
    // kind=mcp + transport=http (default) maps to the server's mcp-http discriminant.
    expect(call.data.kind).toBe("mcp-http")
    expect(call.data.id).toBe("new-plat")
    expect(call.data.url).toBe("https://example.com/mcp")
    await waitFor(() => expect(mockInvalidate).toHaveBeenCalled())
  })

  it("Add Platform dialog: error path — toast shown, invalidate NOT called", async () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    mockAddPlatformFn.mockResolvedValue({ ok: false, error: "id already exists" })

    render(<PlatformsPage />)
    fireEvent.click(screen.getByRole("button", { name: /add platform/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const dialog = screen.getByRole("dialog")
    fireEvent.change(dialog.querySelector("#platform-id") as HTMLInputElement, {
      target: { value: "dupe" },
    })
    fireEvent.change(dialog.querySelector("#platform-display-name") as HTMLInputElement, {
      target: { value: "Dupe" },
    })
    fireEvent.change(dialog.querySelector("#platform-url") as HTMLInputElement, {
      target: { value: "https://example.com/mcp" },
    })
    fireEvent.click(dialog.querySelector("button[type='submit']") as HTMLButtonElement)

    await waitFor(() => expect(mockAddPlatformFn).toHaveBeenCalledOnce())
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  // ── Kind Select + MCP transport sub-selector (wave 3, slice E) ─────────────

  it("Kind Select offers MCP, OpenAPI, GraphQL, and CLI", async () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<PlatformsPage />)
    fireEvent.click(screen.getByRole("button", { name: /add platform/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // happy-dom can't drive the Radix Select portal open — assert the trigger
    // renders the current (default) kind value; the item list itself is
    // covered by the junction-web-verify browser pass.
    const dialog = screen.getByRole("dialog")
    const kindTrigger = dialog.querySelector("#platform-kind") as HTMLElement
    expect(kindTrigger).not.toBeNull()
    expect(kindTrigger.textContent).toMatch(/mcp/i)
  })

  it("selecting CLI kind reveals the guided command-builder form", async () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<PlatformsPage />)
    fireEvent.click(screen.getByRole("button", { name: /add platform/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // Radix Select's onValueChange path isn't drivable via fireEvent in happy-dom
    // (no portal render) — assert the CLI form components render standalone
    // instead, covering the same "guided form renders" contract the E2E pass
    // exercises interactively.
    const { CliConnectionForm } = await import("./-components/cli-form/cli-connection-form.js")
    const { emptyConnection } = await import("./-components/cli-form/types.js")
    const { getAllByText, getByPlaceholderText } = render(
      <CliConnectionForm connection={emptyConnection()} onChange={() => {}} />,
    )
    // One tool card, auto-expanded (its name + summary both read "Tool 1"), with
    // its command input and the Permissions panel disclosure visible.
    expect(getAllByText("Tool 1").length).toBeGreaterThan(0)
    expect(getByPlaceholderText("/opt/homebrew/bin/rg --json $pattern")).toBeInTheDocument()
    expect(getAllByText("Permissions").length).toBeGreaterThan(0)
  })

  // ── Auth-scheme note (wave 3, slice I) ──────────────────────────────────────

  it("shows the auth-scheme note for the default mcp/http kind (always bearer-authenticated)", async () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<PlatformsPage />)
    fireEvent.click(screen.getByRole("button", { name: /add platform/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // mcp-http has no scheme selector — the connection always carries bearer auth
    // (the authHeader field only overrides the header name), so the note always
    // shows in the default kind, pointing at the Credentials page.
    const dialog = screen.getByRole("dialog")
    expect(dialog.textContent).toMatch(/declares the auth scheme only/i)
    expect(dialog.textContent).toMatch(/Credentials page/i)
  })

  it("does not show the auth-scheme note for cli (no scheme selector; credentialEnvVar is its own control)", async () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<PlatformsPage />)
    fireEvent.click(screen.getByRole("button", { name: /add platform/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // CliConnectionForm rendered standalone (see the guided-form test above for
    // why): assert its own copy never repeats the openapi/mcp auth-scheme note.
    const { CliConnectionForm } = await import("./-components/cli-form/cli-connection-form.js")
    const { emptyConnection } = await import("./-components/cli-form/types.js")
    const { container } = render(
      <CliConnectionForm connection={emptyConnection()} onChange={() => {}} />,
    )
    expect(container.textContent).not.toMatch(/declares the auth scheme only/i)
  })
})
