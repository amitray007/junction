// SPDX-License-Identifier: AGPL-3.0-only
// Sidebar tests — grouped nav, collapse state, cookie persistence, a11y landmarks.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SIDEBAR_COOKIE, Sidebar, type SidebarState } from "./sidebar.js"
import { TooltipProvider } from "./tooltip.js"

// ── Mock @tanstack/react-router ──────────────────────────────────────────────
// The Sidebar uses Link + useLocation; we mock them for the happy-dom env.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string
    children: React.ReactNode
    [k: string]: unknown
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/" }),
}))

function renderSidebar(initialState: SidebarState = "expanded") {
  return render(
    <TooltipProvider>
      <Sidebar initialState={initialState} />
    </TooltipProvider>,
  )
}

afterEach(() => {
  cleanup()
  // Reset document.cookie between tests (intentional — test env only)
  // biome-ignore lint/suspicious/noDocumentCookie: intentional test teardown — clears the sidebar cookie between test cases
  document.cookie = `${SIDEBAR_COOKIE}=; max-age=0`
  document.body.removeAttribute("data-sidebar")
})

describe("Sidebar", () => {
  it("renders the main navigation landmark", () => {
    renderSidebar()
    // aria-label="Main navigation" on the <aside>
    expect(screen.getByRole("complementary", { name: "Main navigation" })).toBeInTheDocument()
  })

  it("shows the JUNCTION wordmark when expanded", () => {
    renderSidebar("expanded")
    // Wordmark has aria-label="Junction"
    expect(screen.getByRole("img", { name: "Junction" })).toBeInTheDocument()
  })

  it("renders nav links in the MANAGE group when expanded", () => {
    renderSidebar("expanded")
    // Group eyebrow label
    expect(screen.getByText("Manage")).toBeInTheDocument()
    // Nav links
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Platforms" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Credentials" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Profiles" })).toBeInTheDocument()
  })

  it("marks the Dashboard link as the current page (active route = /)", () => {
    renderSidebar()
    const dashLink = screen.getByRole("link", { name: "Dashboard" })
    expect(dashLink).toHaveAttribute("aria-current", "page")
  })

  it("renders theme toggle button", () => {
    renderSidebar()
    expect(screen.getByRole("button", { name: /Theme:/ })).toBeInTheDocument()
  })

  it("renders toggle sidebar button in the footer", () => {
    renderSidebar()
    // The ⌘B button
    const toggleBtn = screen.getByRole("button", { name: "Toggle sidebar" })
    expect(toggleBtn).toBeInTheDocument()
  })

  it("starts collapsed when initialState is 'collapsed' — links have aria-label", () => {
    // Pre-set the cookie so the useEffect sync also reads "collapsed"
    // biome-ignore lint/suspicious/noDocumentCookie: intentional — seeds the cookie so useEffect reads "collapsed" in happy-dom
    document.cookie = `${SIDEBAR_COOKIE}=collapsed; path=/`
    renderSidebar("collapsed")
    // Collapsed: nav links are icon-only with aria-label
    const dashLink = screen.getByRole("link", { name: "Dashboard" })
    expect(dashLink).toBeInTheDocument()
  })

  it("toggles collapse on Cmd+B keydown and persists cookie", () => {
    // Ensure no stale cookie from a prior test
    // biome-ignore lint/suspicious/noDocumentCookie: intentional — seeds the cookie in happy-dom to ensure clean test state
    document.cookie = `${SIDEBAR_COOKIE}=expanded; path=/`
    renderSidebar("expanded")

    // Fire Cmd+B to collapse
    fireEvent.keyDown(window, { key: "b", metaKey: true })

    // Cookie should be set to "collapsed"
    expect(document.cookie).toContain(`${SIDEBAR_COOKIE}=collapsed`)
  })

  it("renders in dark mode (data-theme=dark) without errors", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() => renderSidebar()).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})
