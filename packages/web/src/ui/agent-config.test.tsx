// SPDX-License-Identifier: AGPL-3.0-only
// Tests for AgentConfig — the Connect-an-Agent block.
// Phase 3 (D5) invariants:
//   - When mcpHost is UNSET: placeholder tokens, no Copy button, "set in Settings" link.
//   - When mcpHost is SET: real endpoint rendered, Copy buttons present, host visible.
//   - EITHER WAY: honesty note ("isn't live yet" + stdio hint) ALWAYS present.
//   - config pre blocks are aria-hidden (non-interactive).
//   - key→profile is demoted to a quiet one-liner (no chips).

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentConfig } from "./agent-config.js"

// Mock @tanstack/react-router's Link so it renders as a plain <a> in happy-dom.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    style,
  }: {
    to: string
    children: React.ReactNode
    style?: React.CSSProperties
  }) => (
    <a href={to} style={style}>
      {children}
    </a>
  ),
}))

afterEach(() => cleanup())

// ── Unset state ───────────────────────────────────────────────────────────────

describe("AgentConfig (mcpHost unset)", () => {
  it("renders without throwing", () => {
    const { container } = render(<AgentConfig mcpHost={undefined} />)
    expect(container.firstChild).toBeInTheDocument()
  })

  it("has a section labelled 'Shared endpoint' (a11y landmark)", () => {
    const { getByRole } = render(<AgentConfig mcpHost={undefined} />)
    expect(getByRole("region", { name: /shared endpoint/i })).toBeInTheDocument()
  })

  it("shows placeholder endpoint with angle-bracket tokens (not a live URL)", () => {
    const { getAllByText } = render(<AgentConfig mcpHost={undefined} />)
    // Placeholder appears in the endpoint span + the active Claude tab pre (2 nodes).
    expect(getAllByText(/your-junction-host/).length).toBeGreaterThanOrEqual(2)
  })

  it("does NOT render a Copy button when host is unset", () => {
    const { queryByRole } = render(<AgentConfig mcpHost={undefined} />)
    expect(queryByRole("button", { name: /copy/i })).not.toBeInTheDocument()
  })

  it("shows 'Set your MCP host in Settings' prompt with a link to /settings", () => {
    const { getByRole } = render(<AgentConfig mcpHost={undefined} />)
    const link = getByRole("link", { name: /settings/i })
    expect(link).toBeInTheDocument()
    expect(link.getAttribute("href")).toBe("/settings")
  })

  it("renders tab triggers for Claude, Cursor, and Today (stdio)", () => {
    const { getByRole } = render(<AgentConfig mcpHost={undefined} />)
    expect(getByRole("tab", { name: "Claude" })).toBeInTheDocument()
    expect(getByRole("tab", { name: "Cursor" })).toBeInTheDocument()
    expect(getByRole("tab", { name: /today/i })).toBeInTheDocument()
  })

  it("config pre block is aria-hidden (non-interactive illustration)", () => {
    const { container } = render(<AgentConfig mcpHost={undefined} />)
    // Only the active tab (Claude, defaultValue) mounts — Radix does not render inactive panels.
    const pres = container.querySelectorAll("pre[aria-hidden='true']")
    expect(pres.length).toBe(1)
  })

  it("renders the honesty note with stdio hint (ALWAYS present)", () => {
    const { getByText } = render(<AgentConfig mcpHost={undefined} />)
    expect(getByText(/junction mcp serve/i)).toBeInTheDocument()
    expect(getByText(/isn.*t live yet/i)).toBeInTheDocument()
  })

  it("renders the Coming soon pill (ALWAYS present)", () => {
    const { getByText } = render(<AgentConfig mcpHost={undefined} />)
    expect(getByText("Coming soon")).toBeInTheDocument()
  })

  it("does NOT render the old key→profile chips (demoted to a one-liner)", () => {
    const { queryByText } = render(<AgentConfig mcpHost={undefined} />)
    expect(queryByText("jk_work → work")).not.toBeInTheDocument()
    expect(queryByText("jk_personal → personal")).not.toBeInTheDocument()
  })

  it("renders the key→profile coming-soon one-liner", () => {
    const { getByText } = render(<AgentConfig mcpHost={undefined} />)
    expect(getByText(/junction key will select which profile/i)).toBeInTheDocument()
  })
})

// ── Set state ─────────────────────────────────────────────────────────────────

describe("AgentConfig (mcpHost set)", () => {
  const HOST = "junction.example.com"

  it("renders without throwing", () => {
    const { container } = render(<AgentConfig mcpHost={HOST} />)
    expect(container.firstChild).toBeInTheDocument()
  })

  it("shows the real endpoint URL (https://<host>/mcp)", () => {
    const { getByText } = render(<AgentConfig mcpHost={HOST} />)
    expect(getByText(`https://${HOST}/mcp`)).toBeInTheDocument()
  })

  it("does NOT show the placeholder angle-bracket tokens when host is set", () => {
    const { queryAllByText } = render(<AgentConfig mcpHost={HOST} />)
    expect(queryAllByText(/your-junction-host/).length).toBe(0)
  })

  it("renders a Copy button for the endpoint", () => {
    const { getByRole } = render(<AgentConfig mcpHost={HOST} />)
    expect(getByRole("button", { name: /copy mcp endpoint url/i })).toBeInTheDocument()
  })

  it("does NOT show the 'Set your MCP host in Settings' prompt", () => {
    const { queryByText } = render(<AgentConfig mcpHost={HOST} />)
    expect(queryByText(/set your mcp host in/i)).not.toBeInTheDocument()
  })

  it("renders the honesty note with stdio hint even when host is set (ALWAYS present)", () => {
    const { getByText } = render(<AgentConfig mcpHost={HOST} />)
    expect(getByText(/junction mcp serve/i)).toBeInTheDocument()
    expect(getByText(/isn.*t live yet/i)).toBeInTheDocument()
  })

  it("renders the Coming soon pill even when host is set (ALWAYS present)", () => {
    const { getByText } = render(<AgentConfig mcpHost={HOST} />)
    expect(getByText("Coming soon")).toBeInTheDocument()
  })
})
