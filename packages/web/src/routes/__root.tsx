// SPDX-License-Identifier: AGPL-3.0-only
// Root route — document shell, app nav, StatusRail, Toaster.
// No @junction/core import. All data flows through server functions.

import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import { Toaster } from "sonner"
import { StatusRail } from "../ui/status-rail.js"
import { TooltipProvider } from "../ui/tooltip.js"
import { Wordmark } from "../ui/wordmark.js"
import "../styles/app.css"

// Pre-hydration theme script — reads localStorage and sets data-theme on <html>
// BEFORE first paint, avoiding a flash of wrong theme. Runs as an inline script
// in <head> so it executes synchronously before any React hydration.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("junction-theme");if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`

type ThemePreference = "system" | "light" | "dark"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Junction" },
    ],
    // Amber-node favicon (SVG, inlined). serve.mjs serves static /assets/* but has
    // no static root for /, so favicon must be inlined to avoid browser /favicon.ico probe.
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E" +
          "%3Crect width='32' height='32' rx='4' fill='%2309090B'/%3E" +
          "%3Crect x='13' y='13' width='6' height='6' fill='%23F59E0B'/%3E" +
          "%3C/svg%3E",
      },
    ],
    // Inline script runs BEFORE React hydration to read localStorage and set
    // data-theme on <html>, preventing a flash of wrong theme on page load.
    scripts: [{ children: THEME_SCRIPT }],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

// Static placeholder segments for the StatusRail (no live events in inc 23).
// The rail reads as the signature element on its own; pulse wires in inc 26+.
const STATIC_RAIL_SEGMENTS = [
  { id: "ph-1", state: "ok" as const, label: "source" },
  { id: "ph-2", state: "ok" as const, label: "source" },
  { id: "ph-3", state: "disabled" as const, label: "source" },
]

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
        style={{ backgroundColor: "var(--bg)", color: "var(--fg)" }}
        className="font-sans antialiased"
      >
        <TooltipProvider>
          {/* App shell: left-edge StatusRail + top nav + content */}
          <div className="flex min-h-screen">
            {/* Left-edge 4px status rail — the signature element */}
            <aside
              aria-label="Connection status"
              className="fixed left-0 top-0 bottom-0 w-1 flex flex-col py-2 z-40"
              style={{ backgroundColor: "var(--surface-2)" }}
            >
              <StatusRail segments={STATIC_RAIL_SEGMENTS} className="flex-1 mx-auto" />
            </aside>

            {/* Main content column (offset by rail width) */}
            <div className="flex-1 flex flex-col pl-1">
              {/* Top navigation */}
              <TopNav />

              {/* Page content */}
              <main
                id="main-content"
                className="flex-1 mx-auto w-full max-w-4xl px-[var(--gutter)] py-8"
              >
                {children}
              </main>
            </div>
          </div>

          {/* Toaster — mounted here, real usage in inc 24+ mutations.
              Tokenized with monospace detail line per DESIGN.md. */}
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-body)",
                background: "var(--surface)",
                color: "var(--fg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
              },
            }}
          />
        </TooltipProvider>

        <Scripts />
      </body>
    </html>
  )
}

function TopNav() {
  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-6 px-[var(--gutter)] h-11 border-b"
      style={{
        backgroundColor: "var(--surface)",
        borderColor: "var(--border)",
      }}
    >
      {/* Wordmark — only Departure Mono usage in the app */}
      <Link
        to="/"
        aria-label="Junction dashboard"
        className="flex items-center no-underline"
        style={{ color: "var(--fg)" }}
      >
        <Wordmark />
      </Link>

      {/* Nav links */}
      <nav aria-label="Main navigation" className="flex items-center gap-1">
        <NavLink to="/">Dashboard</NavLink>
        <NavLink to="/platforms">Platforms</NavLink>
        <NavLink to="/credentials">Credentials</NavLink>
        <NavLink to="/profiles">Profiles</NavLink>
      </nav>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Theme toggle — cycles system → light → dark → system */}
      <ThemeToggle />

      {/* Skip link for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-1 focus:rounded"
        style={{ backgroundColor: "var(--accent-fill)", color: "var(--accent-fg)" }}
      >
        Skip to main content
      </a>
    </header>
  )
}

/** Reads the current theme preference from localStorage (or "system" if not set). */
function readStoredTheme(): ThemePreference {
  try {
    const v = localStorage.getItem("junction-theme")
    if (v === "light" || v === "dark") return v
  } catch {
    // no localStorage (SSR or private browsing)
  }
  return "system"
}

/** Applies a theme preference to the document root and persists to localStorage. */
function applyTheme(pref: ThemePreference) {
  try {
    if (pref === "system") {
      document.documentElement.removeAttribute("data-theme")
      localStorage.removeItem("junction-theme")
    } else {
      document.documentElement.setAttribute("data-theme", pref)
      localStorage.setItem("junction-theme", pref)
    }
  } catch {
    // ignore
  }
}

const THEME_CYCLE: ThemePreference[] = ["system", "light", "dark"]
const THEME_LABEL: Record<ThemePreference, string> = {
  system: "Theme: System",
  light: "Theme: Light",
  dark: "Theme: Dark",
}
const THEME_ICON: Record<ThemePreference, string> = {
  system: "◐",
  light: "☀",
  dark: "☽",
}

function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>("system")

  // Read stored preference on mount (client-only)
  useEffect(() => {
    setPref(readStoredTheme())
  }, [])

  function toggle() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(pref) + 1) % THEME_CYCLE.length] ?? "system"
    applyTheme(next)
    setPref(next)
  }

  return (
    <button
      type="button"
      aria-label={THEME_LABEL[pref]}
      onClick={toggle}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "var(--control-height)",
        height: "var(--control-height)",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        backgroundColor: "transparent",
        color: "var(--muted)",
        fontSize: "var(--text-body)",
        cursor: "pointer",
        lineHeight: 1,
      }}
    >
      <span aria-hidden="true">{THEME_ICON[pref]}</span>
    </button>
  )
}

function NavLink({ to, children }: { readonly to: string; readonly children: ReactNode }) {
  return (
    <Link
      to={to}
      className="px-3 py-1 rounded-[var(--radius-sm)] text-[var(--text-body)] no-underline transition-colors"
      style={{ color: "var(--muted)" }}
      activeProps={{
        style: {
          color: "var(--accent)",
          backgroundColor: "var(--surface-2)",
          fontWeight: "500",
        },
      }}
    >
      {children}
    </Link>
  )
}
