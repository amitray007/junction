// SPDX-License-Identifier: AGPL-3.0-only
// Root route — document shell, app nav, StatusRail, Toaster.
// No @junction/core import. All data flows through server functions.

import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Toaster } from "sonner"
import { StatusRail } from "../ui/status-rail.js"
import { TooltipProvider } from "../ui/tooltip.js"
import { Wordmark } from "../ui/wordmark.js"
import "../styles/app.css"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Junction" },
    ],
    // Amber-node favicon (SVG, inlined). serve.mjs serves NO static files —
    // a public/favicon.ico would 404; this stops the browser's /favicon.ico probe.
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
      // View Transitions for route changes (progressive enhancement)
      onClick={() => {
        if (!document.startViewTransition) return
        // Navigation handled by router — VT fires on the DOM update
      }}
    >
      {children}
    </Link>
  )
}
