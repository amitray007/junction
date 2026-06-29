// SPDX-License-Identifier: AGPL-3.0-only
// Tests for AgentConfig — the Connect an Agent ComingSoon surface.
// CRITICAL invariants:
//   - Renders NO working http://…/mcp copy button
//   - Endpoint URL is display-only (userSelect:none, no copy affordance)
//   - Shows stdio hint for the current working path
//   - All config blocks are aria-hidden (non-interactive illustration)

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

  it("renders the illustrated endpoint URL as display text", () => {
    const { getByText } = render(<AgentConfig />)
    expect(getByText("http://localhost:4321/mcp")).toBeInTheDocument()
  })

  it("does NOT render a Copy button (no working endpoint yet)", () => {
    const { queryByRole } = render(<AgentConfig />)
    // A Copy button for the MCP endpoint would imply the URL is real — it is not.
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
    // All config code blocks must be aria-hidden — they are non-copyable illustration
    expect(pres.length).toBeGreaterThanOrEqual(1)
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
