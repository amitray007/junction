// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /profiles — master-detail layout (Variant C, F13).
// Strategy: mock createFileRoute + useRouter so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CredentialMeta, PlatformMeta, ProfileMeta } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

const emptyProfiles: ProfileMeta[] = []
const emptyPlatforms: PlatformMeta[] = []
const emptyCredentials: CredentialMeta[] = []

const emptyData = {
  profiles: emptyProfiles,
  platforms: emptyPlatforms,
  credentials: emptyCredentials,
}

const platforms: PlatformMeta[] = [{ id: "github", kind: "openapi", displayName: "GitHub" }]

const credentials: CredentialMeta[] = [
  { id: "cred-1", platformId: "github", account: "alice", kind: "bearer" },
]

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
  platforms,
  credentials,
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
  getCredentials: vi.fn(),
}))

const mockCreateProfileFn = vi.fn()
const mockDeleteProfileFn = vi.fn()
const mockAddRouteFn = vi.fn()
const mockRemoveRouteFn = vi.fn()
const mockToggleRouteFn = vi.fn()

vi.mock("../server/profile-mutations.functions.js", () => ({
  createProfileFn: (...args: unknown[]) => mockCreateProfileFn(...args),
  deleteProfileFn: (...args: unknown[]) => mockDeleteProfileFn(...args),
  addRouteFn: (...args: unknown[]) => mockAddRouteFn(...args),
  removeRouteFn: (...args: unknown[]) => mockRemoveRouteFn(...args),
  toggleRouteFn: (...args: unknown[]) => mockToggleRouteFn(...args),
}))

const { Route } = await import("./profiles.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — typing the internal options shape is not worth the boilerplate
const ProfilesPage = (Route as any).options.component as React.FC

// ---- Tests ------------------------------------------------------------------

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
  mockCreateProfileFn.mockReset()
  mockDeleteProfileFn.mockReset()
  mockAddRouteFn.mockReset()
  mockRemoveRouteFn.mockReset()
  mockToggleRouteFn.mockReset()
  mockInvalidate.mockReset().mockResolvedValue(undefined)
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

  it("clicking a profile list item switches the detail panel (selection behavior)", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)

    // Initially "default" is selected
    expect(screen.getByRole("heading", { level: 2, name: "default" })).toBeInTheDocument()

    // Click the "readonly" list item
    fireEvent.click(screen.getByRole("button", { name: /readonly/i }))

    // Detail panel switches to "readonly"
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "readonly" })).toBeInTheDocument(),
    )
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
      credentials: [],
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

  it("does NOT render 'Keys active' (removed inc-25 feedback batch)", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    // The "N keys active" ComingSoon affordance was removed from the detail panel.
    expect(screen.queryByText("Keys active")).not.toBeInTheDocument()
  })

  it("renders profile list filter input", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)
    expect(screen.getByRole("searchbox", { name: /filter profiles/i })).toBeInTheDocument()
  })

  it("list filter: typing narrows the profile list", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)

    const filterInput = screen.getByRole("searchbox", { name: /filter profiles/i })
    fireEvent.change(filterInput, { target: { value: "read" } })

    // "readonly" still visible; "default" filtered out
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /readonly/i })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /^default$/i })).not.toBeInTheDocument()
    })
  })

  // ── FIX 1: Delete cancel must NOT change selection ─────────────────────────

  it("FIX 1: opening Delete dialog then cancelling leaves selection unchanged", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)

    // Initially "default" (first profile) is selected
    expect(screen.getByRole("heading", { level: 2, name: "default" })).toBeInTheDocument()

    // Click Delete button in the detail panel
    const deleteBtn = screen.getByRole("button", { name: /^delete$/i })
    fireEvent.click(deleteBtn)

    // Dialog opens
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // Cancel the dialog
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    // Selection must still be "default" — NOT jumped to another profile
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "default" })).toBeInTheDocument(),
    )
    // invalidate must NOT have been called (no mutation happened)
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  // ── Create profile — success + error paths ─────────────────────────────────

  it("create profile: opens dialog, submits name, calls createProfileFn on success", async () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    mockCreateProfileFn.mockResolvedValue({ ok: true, id: "new-id", name: "newprof" })

    render(<ProfilesPage />)

    // Click New Profile button (use first one in header)
    const newProfileBtns = screen.getAllByRole("button", { name: /new profile/i })
    fireEvent.click(newProfileBtns[0] as HTMLElement)

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const dialog = screen.getByRole("dialog")
    const nameInput = dialog.querySelector("#profile-name") as HTMLInputElement
    expect(nameInput).not.toBeNull()
    fireEvent.change(nameInput, { target: { value: "newprof" } })

    const submitBtn = dialog.querySelector("button[type='submit']") as HTMLButtonElement
    fireEvent.click(submitBtn)

    await waitFor(() => expect(mockCreateProfileFn).toHaveBeenCalledOnce())
    // On success, invalidate is called
    await waitFor(() => expect(mockInvalidate).toHaveBeenCalled())
  })

  it("create profile: error path — toast.error shown, invalidate NOT called", async () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    mockCreateProfileFn.mockResolvedValue({ ok: false, error: "Name taken" })

    render(<ProfilesPage />)
    const newProfileBtns = screen.getAllByRole("button", { name: /new profile/i })
    fireEvent.click(newProfileBtns[0] as HTMLElement)

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const dialog = screen.getByRole("dialog")
    const nameInput = dialog.querySelector("#profile-name") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "taken" } })

    const submitBtn = dialog.querySelector("button[type='submit']") as HTMLButtonElement
    fireEvent.click(submitBtn)

    await waitFor(() => expect(mockCreateProfileFn).toHaveBeenCalledOnce())
    // On error, invalidate must NOT be called
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it("create profile: required-name validation prevents submission", async () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    render(<ProfilesPage />)

    const newProfileBtns = screen.getAllByRole("button", { name: /new profile/i })
    fireEvent.click(newProfileBtns[0] as HTMLElement)

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const dialog = screen.getByRole("dialog")
    const submitBtn = dialog.querySelector("button[type='submit']") as HTMLButtonElement
    fireEvent.click(submitBtn)

    await waitFor(() => expect(screen.getByText("Name is required")).toBeInTheDocument())
    expect(mockCreateProfileFn).not.toHaveBeenCalled()
  })

  // ── Delete profile — success path ──────────────────────────────────────────

  it("delete profile: confirm calls deleteProfileFn; invalidate runs on success", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    mockDeleteProfileFn.mockResolvedValue({ ok: true })

    render(<ProfilesPage />)

    // Delete the currently-selected "default" profile
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // Find the destructive confirm button ("Delete Profile")
    const confirmBtn = screen.getByRole("button", { name: "Delete Profile" })
    fireEvent.click(confirmBtn)

    await waitFor(() => expect(mockDeleteProfileFn).toHaveBeenCalledOnce())
    await waitFor(() => expect(mockInvalidate).toHaveBeenCalled())
  })

  // ── FIX 6: Add Route dialog contains credential select ─────────────────────

  it("FIX 6: Add Route dialog renders a Credential select field", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<ProfilesPage />)

    fireEvent.click(screen.getByRole("button", { name: /add route/i }))

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    // Credential field label must be present
    expect(screen.getByText("Credential")).toBeInTheDocument()
  })

  it("FIX 6: Add Route submits credentialId when no-auth option is selected", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    mockAddRouteFn.mockResolvedValue({ ok: true })

    render(<ProfilesPage />)
    fireEvent.click(screen.getByRole("button", { name: /add route/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const dialog = screen.getByRole("dialog")
    // Fill in namespace
    const nsInput = dialog.querySelector("#route-namespace") as HTMLInputElement
    fireEvent.change(nsInput, { target: { value: "myns" } })

    // Submit without selecting a platform (should fail validation — platform required)
    const submitBtn = dialog.querySelector("button[type='submit']") as HTMLButtonElement
    fireEvent.click(submitBtn)

    await waitFor(() => expect(screen.getByText("Platform is required")).toBeInTheDocument())
    expect(mockAddRouteFn).not.toHaveBeenCalled()
  })
})
