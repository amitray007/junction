// SPDX-License-Identifier: AGPL-3.0-only
// Route/component tests for /audit — the real filterable audit table (increment
// 32.6b). Strategy: mock createFileRoute so Route.useLoaderData() returns test
// fixtures, then import the module and render Route.options.component.
// The server-fn (getAudit) is mocked so happy-dom never calls getRequest()/core.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AuditEntryDTO } from "../server/audit.functions.js"

const emptyData = { entries: [] as AuditEntryDTO[], skipped: 0, truncated: false, total: 0 }

const okEntry: AuditEntryDTO = {
  ts: "2026-07-01T12:00:00.000Z",
  principalKind: "api-key",
  keyId: "key-abc",
  label: "claude-code",
  profile: "work",
  namespace: "github",
  tool: "search_repos",
  argKeys: ["query", "page"],
  durationMs: 42,
  outcome: "ok",
  errorKind: null,
}

const errorEntry: AuditEntryDTO = {
  ts: "2026-07-02T08:30:00.000Z",
  principalKind: "stdio",
  keyId: null,
  label: null,
  profile: "personal",
  namespace: "slack",
  tool: "send_message",
  argKeys: [],
  durationMs: 15,
  outcome: "error",
  errorKind: "auth-failed",
}

const populatedData = {
  entries: [okEntry, errorEntry],
  skipped: 0,
  truncated: false,
  total: 2,
}

const truncatedData = {
  entries: [okEntry],
  skipped: 0,
  truncated: true,
  total: 1,
}

const mockUseLoaderData = vi.fn().mockReturnValue(emptyData)
const mockInvalidate = vi.fn().mockResolvedValue(undefined)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  useRouter: () => ({ invalidate: mockInvalidate }),
}))

const mockGetAudit = vi.fn()
vi.mock("../server/audit.functions.js", () => ({
  getAudit: (...args: unknown[]) => mockGetAudit(...args),
}))

const { Route } = await import("./audit.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — internal options shape
const AuditPage = (Route as any).options.component as React.FC

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
  mockGetAudit.mockReset()
})

describe("AuditPage — landmark + empty state", () => {
  it("renders the page heading as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    const { getByRole } = render(<AuditPage />)
    expect(getByRole("heading", { level: 1, name: "Audit" })).toBeInTheDocument()
  })

  it("shows an honest empty state when there are no entries", () => {
    mockUseLoaderData.mockReturnValue(emptyData)
    render(<AuditPage />)
    expect(screen.getByText(/No tool calls recorded yet/i)).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })
})

describe("AuditPage — populated table", () => {
  it("renders a row per audit entry with principal/profile/tool/duration", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByRole } = render(<AuditPage />)
    const table = getByRole("table")
    expect(table.textContent).toContain("claude-code")
    expect(table.textContent).toContain("work")
    expect(table.textContent).toContain("github__search_repos")
    expect(table.textContent).toContain("42ms")
  })

  it("shows an ok badge for a successful call", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByRole } = render(<AuditPage />)
    expect(getByRole("table").textContent).toContain("Connected")
  })

  it("shows an error badge + errorKind for a failed call", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByRole } = render(<AuditPage />)
    const table = getByRole("table")
    expect(table.textContent).toContain("Auth Failed")
    expect(table.textContent).toContain("auth-failed")
  })

  it("shows a truncated note when the log exceeded the tail cap", () => {
    mockUseLoaderData.mockReturnValue(truncatedData)
    render(<AuditPage />)
    expect(screen.getByText(/showing the most recent entries only/i)).toBeInTheDocument()
  })

  it("does not show the truncated note when the log fit within the cap", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    render(<AuditPage />)
    expect(screen.queryByText(/showing the most recent entries only/i)).not.toBeInTheDocument()
  })
})

describe("AuditPage — filters narrow visible rows", () => {
  it("the profile facet filters rows by profile", async () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByRole } = render(<AuditPage />)
    expect(getByRole("table").textContent).toContain("personal")

    const profileSelect = screen.getByRole("combobox", { name: /filter by profile/i })
    fireEvent.click(profileSelect)
    const option = await screen.findByRole("option", { name: "work" })
    fireEvent.click(option)

    const filteredTable = getByRole("table")
    expect(filteredTable.textContent).toContain("work")
    expect(filteredTable.textContent).not.toContain("personal")
  })

  it("the search box filters rows by text (tool name)", () => {
    mockUseLoaderData.mockReturnValue(populatedData)
    const { getByRole } = render(<AuditPage />)
    const searchBox = screen.getByRole("searchbox", { name: /search audit entries/i })
    fireEvent.change(searchBox, { target: { value: "send_message" } })

    const filteredTable = getByRole("table")
    expect(filteredTable.textContent).toContain("personal")
    expect(filteredTable.textContent).not.toContain("work")
  })
})
