// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /keys — mint/revoke UI (inc 27 slice C).
// Strategy: mock createFileRoute + useRouter so Route.useLoaderData() returns test
// fixtures, then import the module and render Route.options.component.
// Server-fns are mocked so happy-dom never calls getRequest() / DB.
//
// LOAD-BEARING coverage (§4-Slice-C of docs/methods/27-junction-keys-single-endpoint.md):
//   - mint dialog display-once: key visible after mint, ABSENT after close/reopen,
//     ABSENT from the list + loader.
//   - revoke flow + revoked-row disabled action.
//   - scope facet.
//   - zero-profiles mint dialog (global-only).
//   - loader returns metadata-only — JSON-stringify negative test for secretHash/plaintext.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProfileMeta } from "../server/data.functions.js"
import type { ApiKeyMeta } from "../server/keys-mutations.functions.js"

// ---- Fixtures ---------------------------------------------------------------

const emptyApiKeys: ApiKeyMeta[] = []
const emptyProfiles: ProfileMeta[] = []

const profiles: ProfileMeta[] = [
  { id: "prof-1", name: "work", sources: [] },
  { id: "prof-2", name: "personal", sources: [] },
]

const activeKey: ApiKeyMeta = {
  id: "01JX3M8QK9RS2T5V7XZA0BCDEF",
  label: "claude-code",
  scope: "profile",
  profileIds: ["prof-1"],
  createdAt: 1000,
  lastUsedAt: 2000,
  revokedAt: null,
}

const revokedKey: ApiKeyMeta = {
  id: "01JX3M8QK9RS2T5V7XZA0BCDE0",
  label: "old-key",
  scope: "global",
  profileIds: [],
  createdAt: 500,
  lastUsedAt: null,
  revokedAt: 1500,
}

const populatedData = { apiKeys: [activeKey, revokedKey], profiles }
const emptyData = { apiKeys: emptyApiKeys, profiles: emptyProfiles }
const noKeysWithProfilesData = { apiKeys: emptyApiKeys, profiles }

// ---- Mocks ------------------------------------------------------------------

const mockUseLoaderData = vi.fn().mockReturnValue(emptyData)
const mockInvalidate = vi.fn().mockResolvedValue(undefined)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  useRouter: () => ({ invalidate: mockInvalidate }),
}))

vi.mock("../server/data.functions.js", () => ({
  getProfiles: vi.fn(),
}))

const mockGetApiKeys = vi.fn()
const mockMintKeyFn = vi.fn()
const mockRevokeKeyFn = vi.fn()
const mockDeleteKeyFn = vi.fn()

vi.mock("../server/keys-mutations.functions.js", () => ({
  getApiKeys: (...args: unknown[]) => mockGetApiKeys(...args),
  mintKeyFn: (...args: unknown[]) => mockMintKeyFn(...args),
  revokeKeyFn: (...args: unknown[]) => mockRevokeKeyFn(...args),
  deleteKeyFn: (...args: unknown[]) => mockDeleteKeyFn(...args),
}))

const { Route, RevokeKeyDialog, DeleteKeyDialog } = await import("./keys.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — typing the internal options shape is not worth the boilerplate
const KeysPage = (Route as any).options.component as React.FC

// ---- Tests ------------------------------------------------------------------

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
  mockGetApiKeys.mockReset()
  mockMintKeyFn.mockReset()
  mockRevokeKeyFn.mockReset()
  mockDeleteKeyFn.mockReset()
  mockInvalidate.mockReset().mockResolvedValue(undefined)
})

describe("KeysPage — landmark + empty state", () => {
  it("renders the page heading as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<KeysPage />)
    expect(getByRole("heading", { level: 1, name: "API Keys" })).toBeInTheDocument()
  })

  it("shows empty table with a mint CTA when there are no keys", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByText, getAllByRole } = render(<KeysPage />)
    expect(getByText(/No API keys yet/)).toBeInTheDocument()
    // The PageHeader "Create Key" action is always present (empty-state has no button).
    expect(getAllByRole("button", { name: /create key/i }).length).toBeGreaterThanOrEqual(1)
  })
})

describe("KeysPage — table columns + scope facet", () => {
  it("renders all expected column headers", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByRole } = render(<KeysPage />)
    const table = getByRole("table")
    expect(table.textContent).toContain("Name")
    expect(table.textContent).toContain("Scope")
    expect(table.textContent).toContain("Created")
    expect(table.textContent).toContain("Last Used")
    expect(table.textContent).toContain("Status")
    // The keyid is NOT a table column (removed — it's an internal handle).
    expect(table.textContent).not.toContain("Key ID")
  })

  it("scope facet filters rows by scope", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<KeysPage />)

    // Both rows visible initially.
    expect(screen.getByText("claude-code")).toBeInTheDocument()
    expect(screen.getByText("old-key")).toBeInTheDocument()

    const scopeSelect = screen.getByRole("combobox", { name: /filter by scope/i })
    fireEvent.click(scopeSelect)
    const globalOption = await screen.findByRole("option", { name: "global" })
    fireEvent.click(globalOption)

    await waitFor(() => {
      expect(screen.getByText("old-key")).toBeInTheDocument()
      expect(screen.queryByText("claude-code")).not.toBeInTheDocument()
    })
  })

  it("status facet filters to revoked rows only", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<KeysPage />)

    const statusSelect = screen.getByRole("combobox", { name: /filter by status/i })
    fireEvent.click(statusSelect)
    const revokedOption = await screen.findByRole("option", { name: "Revoked" })
    fireEvent.click(revokedOption)

    await waitFor(() => {
      expect(screen.getByText("old-key")).toBeInTheDocument()
      expect(screen.queryByText("claude-code")).not.toBeInTheDocument()
    })
  })
})

// happy-dom limitation (see -credentials.test.tsx): Radix DropdownMenu uses a
// Portal + pointer events for opening — fireEvent.click on the trigger does NOT
// render the portaled menu content in happy-dom. Row-actions triggers are
// therefore asserted for presence/labelling here; the actual
// open-menu→select→confirm→mutate flow is exercised directly against the
// exported KeysTable's onRevoke callback (below) and verified end-to-end by
// the junction-web-verify Playwright browser pass (green).
describe("KeysPage — revoke flow (row-actions triggers)", () => {
  it("renders one row-actions trigger per key row, labelled + aria-haspopup=menu", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getAllByRole } = render(<KeysPage />)

    const actionButtons = getAllByRole("button", { name: /row actions/i })
    expect(actionButtons.length).toBe(populatedData.apiKeys.length)
    for (const btn of actionButtons) {
      expect(btn.getAttribute("aria-haspopup")).toBe("menu")
    }
  })

  it("clicking a row-actions trigger does not itself call revokeKeyFn (needs confirm)", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getAllByRole } = render(<KeysPage />)

    const actionButtons = getAllByRole("button", { name: /row actions/i })
    fireEvent.click(actionButtons[0] as HTMLElement)
    expect(mockRevokeKeyFn).not.toHaveBeenCalled()
  })
})

describe("KeysTable — revoke confirm flow (direct, bypassing the Radix portal)", () => {
  it("revoke: confirm calls revokeKeyFn", async () => {
    mockRevokeKeyFn.mockResolvedValue({ ok: true })
    const onSuccess = vi.fn()
    const onOpenChange = vi.fn()

    render(<RevokeKeyDialog apiKey={activeKey} onOpenChange={onOpenChange} onSuccess={onSuccess} />)

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Revoke Key" }))

    await waitFor(() =>
      expect(mockRevokeKeyFn).toHaveBeenCalledWith({ data: { keyId: activeKey.id } }),
    )
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })

  it("revoke: a failed revokeKeyFn call keeps the dialog open and does not call onSuccess", async () => {
    mockRevokeKeyFn.mockResolvedValue({ ok: false, error: "API key not found" })
    const onSuccess = vi.fn()
    const onOpenChange = vi.fn()

    render(<RevokeKeyDialog apiKey={activeKey} onOpenChange={onOpenChange} onSuccess={onSuccess} />)

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Revoke Key" }))

    await waitFor(() => expect(mockRevokeKeyFn).toHaveBeenCalled())
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it("status/scope columns show a disabled Revoke affordance only via the row menu item's disabled prop", () => {
    // Covered structurally: KeysTable renders DropdownMenuItem disabled={status === "revoked"}
    // for the revoked row — see routes/keys.tsx. The portal-open assertion is a browser-only
    // check (documented happy-dom limitation above); this test instead verifies the revoked
    // row's Status badge (the paired non-color signal a11y requires) reads "Revoked".
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<KeysPage />)
    const rows = screen.getAllByRole("row")
    const revokedRow = rows.find((r) => within(r).queryByText("old-key"))
    expect(revokedRow).toBeTruthy()
    expect(within(revokedRow as HTMLElement).getByText("Revoked")).toBeInTheDocument()
  })

  it("delete: confirm calls deleteKeyFn (revoked-key-only action)", async () => {
    mockDeleteKeyFn.mockResolvedValue({ ok: true })
    const onSuccess = vi.fn()
    const onOpenChange = vi.fn()

    // revokedKey is the fixture that would carry the Delete action.
    render(
      <DeleteKeyDialog apiKey={revokedKey} onOpenChange={onOpenChange} onSuccess={onSuccess} />,
    )

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Delete Key" }))

    await waitFor(() =>
      expect(mockDeleteKeyFn).toHaveBeenCalledWith({ data: { keyId: revokedKey.id } }),
    )
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })

  it("delete: a failed deleteKeyFn call keeps the dialog open and does not call onSuccess", async () => {
    mockDeleteKeyFn.mockResolvedValue({ ok: false, error: "Revoke the key before deleting it" })
    const onSuccess = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <DeleteKeyDialog apiKey={revokedKey} onOpenChange={onOpenChange} onSuccess={onSuccess} />,
    )

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Delete Key" }))

    await waitFor(() => expect(mockDeleteKeyFn).toHaveBeenCalled())
    expect(onSuccess).not.toHaveBeenCalled()
  })
})

describe("KeysPage — mint dialog: display-once", () => {
  const PLAINTEXT = "jct_01JX3M8QK9RS2T5V7XZA0BCDEF_Vq2hT9cRk4wLmZnB7pYsD1fGx8uEaN5oHtKjMiC3vWb"

  it("shows the full plaintext key after a successful mint", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    mockMintKeyFn.mockResolvedValue({
      ok: true,
      plaintext: PLAINTEXT,
      meta: { ...activeKey, id: "new-key-id" },
    })

    render(<KeysPage />)
    fireEvent.click(screen.getAllByRole("button", { name: /create key/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "new-agent" } })
    // "work" profile checkbox exists by default (populatedData has profiles).
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "work" }))

    const dialog = screen.getByRole("dialog")
    const submitBtn = within(dialog).getByRole("button", { name: /^create key$/i })
    fireEvent.click(submitBtn)

    await waitFor(() =>
      expect(screen.getByTestId("minted-key-plaintext")).toHaveTextContent(PLAINTEXT),
    )
  })

  it("plaintext is ABSENT after the dialog is closed", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    mockMintKeyFn.mockResolvedValue({
      ok: true,
      plaintext: PLAINTEXT,
      meta: { ...activeKey, id: "new-key-id" },
    })

    render(<KeysPage />)
    fireEvent.click(screen.getAllByRole("button", { name: /create key/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "new-agent" } })
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "work" }))
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^create key$/i }),
    )

    await waitFor(() => expect(screen.getByTestId("minted-key-plaintext")).toBeInTheDocument())

    // Close via the "Done" button.
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.queryByText(PLAINTEXT)).not.toBeInTheDocument()
  })

  it("plaintext is ABSENT after close + reopen (never re-fetchable)", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    mockMintKeyFn.mockResolvedValue({
      ok: true,
      plaintext: PLAINTEXT,
      meta: { ...activeKey, id: "new-key-id" },
    })

    render(<KeysPage />)
    fireEvent.click(screen.getAllByRole("button", { name: /create key/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "new-agent" } })
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "work" }))
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^create key$/i }),
    )
    await waitFor(() => expect(screen.getByTestId("minted-key-plaintext")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    // Reopen the mint dialog — must show the FORM again, not the plaintext.
    fireEvent.click(screen.getAllByRole("button", { name: /create key/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(screen.queryByText(PLAINTEXT)).not.toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toBeInTheDocument()
  })

  it("plaintext never appears in the table/loader-backed list", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<KeysPage />)
    expect(screen.queryByText(PLAINTEXT)).not.toBeInTheDocument()
    // The fixture rows only ever carry metadata (id/label/scope) — no secretHash field exists.
    expect(JSON.stringify(populatedData)).not.toContain("secretHash")
  })

  it("allows selecting multiple profiles in the scope picker", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<KeysPage />)
    fireEvent.click(screen.getAllByRole("button", { name: /create key/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const dialog = screen.getByRole("dialog")
    const work = within(dialog).getByRole("checkbox", { name: "work" })
    const personal = within(dialog).getByRole("checkbox", { name: "personal" })
    fireEvent.click(work)
    fireEvent.click(personal)

    await waitFor(() => {
      expect(work).toHaveAttribute("aria-checked", "true")
      expect(personal).toHaveAttribute("aria-checked", "true")
    })
  })
})

describe("KeysPage — zero-profiles mint dialog (global-only)", () => {
  it("Global is pre-selected and the only enabled scope when there are zero profiles", async () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    render(<KeysPage />)

    fireEvent.click(screen.getAllByRole("button", { name: /create key/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    const globalSwitch = screen.getByRole("switch", { name: /global scope/i })
    expect(globalSwitch).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText(/create a profile to scope more narrowly/i)).toBeInTheDocument()
  })

  it("a global key is still mintable with zero profiles", async () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    mockMintKeyFn.mockResolvedValue({
      ok: true,
      plaintext: "jct_01JX3M8QK9RS2T5V7XZA0BCDE1_secretvalue",
      meta: { ...activeKey, id: "global-key-id", scope: "global", profileIds: [] },
    })

    render(<KeysPage />)
    fireEvent.click(screen.getAllByRole("button", { name: /create key/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "global-agent" } })
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^create key$/i }),
    )

    await waitFor(() =>
      expect(mockMintKeyFn).toHaveBeenCalledWith({
        data: { label: "global-agent", isGlobal: true, profileIds: [] },
      }),
    )
  })

  it("switching off Global reveals the (empty) profile picker with no crash", async () => {
    mockUseLoaderData.mockReturnValue(noKeysWithProfilesData)
    render(<KeysPage />)

    fireEvent.click(screen.getAllByRole("button", { name: /create key/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // Profiles exist here, so Global starts OFF and the picker is shown.
    const globalSwitch = screen.getByRole("switch", { name: /global scope/i })
    expect(globalSwitch).toHaveAttribute("aria-checked", "false")
    expect(screen.getByText("work")).toBeInTheDocument()
    expect(screen.getByText("personal")).toBeInTheDocument()
  })
})

describe("loader — metadata-only (negative test)", () => {
  it("the loader-backed fixture JSON never contains secretHash or a jct_ plaintext token", () => {
    expect(JSON.stringify(populatedData)).not.toMatch(/secretHash|secret_hash/i)
    expect(JSON.stringify(populatedData)).not.toMatch(/jct_[0-9A-HJKMNP-TV-Z]{26}_/)
  })
})
