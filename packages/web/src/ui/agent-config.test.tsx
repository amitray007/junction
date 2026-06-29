// SPDX-License-Identifier: AGPL-3.0-only
// Tests for AgentConfig — the Connect an Agent ComingSoon surface.
// CRITICAL invariants:
//   - Endpoint is a placeholder shape (angle-bracket tokens), NOT a localhost URL
//   - Renders NO Copy button (no working endpoint today — stdio only)
//   - All config blocks are aria-hidden (non-interactive illustration)
//   - Shows stdio hint as the one truthful/current action

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { AgentConfig } from "./agent-config.js"

afterEach(() => cleanup())

describe("AgentConfig", () => {
  it("renders without throwing", () => {
    const { container } = render(<AgentConfig />)
    expect(container.firstChild).toBeInTheDocument()
  })

  it("has a section with labelledby heading (a11y landmark)", () => {
    const { getByRole } = render(<AgentConfig />)
    // aria-labelledby="agent-config-heading" makes this a labelled region
    expect(getByRole("region", { name: /shared endpoint/i })).toBeInTheDocument()
  })

  it("renders a placeholder endpoint with angle-bracket tokens (NOT a localhost URL)", () => {
    const { getAllByText, queryByText } = render(<AgentConfig />)
    // Placeholder must use angle-bracket form — unmistakably illustrative, not live config.
    // Appears in the endpoint span (1) + the active Claude tab pre (1) = 2 nodes total.
    // (Radix Tabs only mounts the active panel; Cursor/stdio tabs are not in DOM.)
    expect(getAllByText(/your-junction-host/).length).toBe(2)
    // Must NOT show any localhost URL — that would look like real, paste-able config.
    expect(queryByText(/localhost/)).not.toBeInTheDocument()
  })

  it("does NOT render a Copy button (no working endpoint today — stdio only)", () => {
    const { queryByRole } = render(<AgentConfig />)
    // A Copy button would imply the URL is real and paste-able — it is not.
    const buttons = queryByRole("button", { name: /copy/i })
    expect(buttons).not.toBeInTheDocument()
  })

  it("renders tab triggers for Claude, Cursor, and Today (stdio)", () => {
    const { getByRole } = render(<AgentConfig />)
    expect(getByRole("tab", { name: "Claude" })).toBeInTheDocument()
    expect(getByRole("tab", { name: "Cursor" })).toBeInTheDocument()
    expect(getByRole("tab", { name: /today/i })).toBeInTheDocument()
  })

  it("config pre blocks are aria-hidden (non-interactive illustration)", () => {
    const { container } = render(<AgentConfig />)
    const pres = container.querySelectorAll("pre[aria-hidden='true']")
    // Only the active tab panel (Claude, defaultValue) mounts — Radix does not render
    // inactive panels without forceMount. Exactly 1 aria-hidden <pre> is in the DOM.
    expect(pres.length).toBe(1)
  })

  it("renders the stdio hint for current working path", () => {
    const { getByText } = render(<AgentConfig />)
    expect(getByText(/junction mcp serve/i)).toBeInTheDocument()
  })

  it("renders 'Coming soon' pill (the entire block is a ComingSoon surface)", () => {
    const { getByText } = render(<AgentConfig />)
    expect(getByText("Coming soon")).toBeInTheDocument()
  })

  it("renders key→profile illustrative chips", () => {
    const { getByText } = render(<AgentConfig />)
    expect(getByText("jk_work → work")).toBeInTheDocument()
    expect(getByText("jk_personal → personal")).toBeInTheDocument()
  })
})
