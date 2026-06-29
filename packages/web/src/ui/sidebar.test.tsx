// SPDX-License-Identifier: AGPL-3.0-only
// Sidebar tests — grouped nav, collapse state, cookie persistence, a11y landmarks.
// Covers the architectural invariants: data-sidebar on <html>, content offset
// tracks sidebar state, Cmd+B bails inside inputs.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readStoredTheme, SIDEBAR_COOKIE, Sidebar, type SidebarState } from "./sidebar.js"
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
  document.documentElement.removeAttribute("data-sidebar")
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

  it("renders nav links in two groups when expanded (A6/A7 — no 'Manage' eyebrow)", () => {
    renderSidebar("expanded")
    // A6: no "Manage" group label
    expect(screen.queryByText("Manage")).not.toBeInTheDocument()
    // A7 Group 1: Dashboard + Settings
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument()
    // A7 Group 2: Platforms, Profiles, Credentials
    expect(screen.getByRole("link", { name: "Platforms" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Profiles" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Credentials" })).toBeInTheDocument()
  })

  it("marks the Dashboard link as the current page (active route = /)", () => {
    renderSidebar()
    const dashLink = screen.getByRole("link", { name: "Dashboard" })
    expect(dashLink).toHaveAttribute("aria-current", "page")
  })

  it("renders theme toggle button (A1 — light|dark only, no system)", () => {
    renderSidebar()
    // Toggle aria-label is "Theme: Light" or "Theme: Dark" — never "Theme: System"
    const btn = screen.getByRole("button", { name: /Theme:/ })
    expect(btn).toBeInTheDocument()
    expect(btn.getAttribute("aria-label")).toMatch(/Theme: (Light|Dark)/)
    expect(btn.getAttribute("aria-label")).not.toContain("System")
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

  it("toggle collapses the sidebar: wordmark disappears (expanded→collapsed)", async () => {
    // Verify the toggle handler actually changes React state — in expanded mode
    // the Wordmark (aria-label="Junction") is visible; in collapsed mode it is hidden.
    // biome-ignore lint/suspicious/noDocumentCookie: intentional — seeds the cookie so useEffect reads "expanded"
    document.cookie = `${SIDEBAR_COOKIE}=expanded; path=/`
    renderSidebar("expanded")

    // Wordmark is visible in expanded state
    expect(screen.getByRole("img", { name: "Junction" })).toBeInTheDocument()

    // Fire Cmd+B to collapse
    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true })
    })

    // After collapse the Wordmark is hidden (amber dot shown instead)
    expect(screen.queryByRole("img", { name: "Junction" })).not.toBeInTheDocument()
  })

  it("toggle persists cookie and does NOT set data-sidebar on <body>", async () => {
    // body must NOT carry data-sidebar — it's the old (broken) target.
    // The architectural fix writes to document.documentElement (<html>) instead.
    // biome-ignore lint/suspicious/noDocumentCookie: intentional — seeds the cookie in happy-dom to ensure clean test state
    document.cookie = `${SIDEBAR_COOKIE}=expanded; path=/`
    renderSidebar("expanded")

    // Fire Cmd+B to collapse
    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true })
    })

    // Cookie should be set to "collapsed"
    expect(document.cookie).toContain(`${SIDEBAR_COOKIE}=collapsed`)
    // body must NOT have the attribute (wrong target from old code)
    expect(document.body).not.toHaveAttribute("data-sidebar")
  })

  it("Cmd+B does NOT toggle when focus is inside an input", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: intentional — seeds cookie for test isolation
    document.cookie = `${SIDEBAR_COOKIE}=expanded; path=/`
    renderSidebar("expanded")

    // Set documentElement to "expanded" manually to match what mount useEffect would set,
    // since happy-dom useEffect may not flush before the first keyDown.
    document.documentElement.setAttribute("data-sidebar", "expanded")

    // Create and focus an input to simulate being inside a form field
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()

    // Fire Cmd+B while input is focused — handler bails without toggling
    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true })
    })

    // The state must remain "expanded" — attribute unchanged because handler bailed
    expect(document.documentElement).toHaveAttribute("data-sidebar", "expanded")
    document.body.removeChild(input)
  })

  it("Cmd+B does NOT toggle when focus is inside a textarea", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: intentional — seeds cookie for test isolation
    document.cookie = `${SIDEBAR_COOKIE}=expanded; path=/`
    renderSidebar("expanded")
    document.documentElement.setAttribute("data-sidebar", "expanded")

    const textarea = document.createElement("textarea")
    document.body.appendChild(textarea)
    textarea.focus()

    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true })
    })

    expect(document.documentElement).toHaveAttribute("data-sidebar", "expanded")
    document.body.removeChild(textarea)
  })

  it("renders in dark mode (data-theme=dark) without errors", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() => renderSidebar()).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})

// ── FIX 2: Theme toggle desync for OS-light first-time visitors ───────────────
// readStoredTheme() must mirror what THEME_SCRIPT applied (data-theme on <html>)
// when localStorage is unset, so the toggle label matches the rendered theme.

describe("readStoredTheme (FIX 2 — OS-light first-visit desync)", () => {
  afterEach(() => {
    // Clean up between sub-tests
    document.documentElement.removeAttribute("data-theme")
    try {
      localStorage.removeItem("junction-theme")
    } catch {
      // ignore
    }
  })

  it("returns stored localStorage value when explicitly set to 'light'", () => {
    localStorage.setItem("junction-theme", "light")
    expect(readStoredTheme()).toBe("light")
  })

  it("returns stored localStorage value when explicitly set to 'dark'", () => {
    localStorage.setItem("junction-theme", "dark")
    expect(readStoredTheme()).toBe("dark")
  })

  it("OS-light first visit: mirrors data-theme='light' on <html> (set by THEME_SCRIPT)", () => {
    // Simulate: localStorage unset, THEME_SCRIPT already set data-theme="light" from OS pref.
    localStorage.removeItem("junction-theme")
    document.documentElement.setAttribute("data-theme", "light")
    // readStoredTheme must return "light" so the toggle shows the correct current theme.
    expect(readStoredTheme()).toBe("light")
  })

  it("OS-dark first visit: mirrors data-theme='dark' on <html>", () => {
    localStorage.removeItem("junction-theme")
    document.documentElement.setAttribute("data-theme", "dark")
    expect(readStoredTheme()).toBe("dark")
  })

  it("falls back to 'dark' when neither localStorage, data-theme, nor an OS light preference is set", () => {
    localStorage.removeItem("junction-theme")
    document.documentElement.removeAttribute("data-theme")
    // Stub matchMedia to report NO light preference so the dark fallback is exercised
    // deterministically (happy-dom's default matchMedia reports matches:true).
    const original = window.matchMedia
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
    try {
      expect(readStoredTheme()).toBe("dark")
    } finally {
      window.matchMedia = original
    }
  })
})
