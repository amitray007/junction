// SPDX-License-Identifier: AGPL-3.0-only
// Root route — document shell, fixed five-zone app shell, StatusRail, Toaster.
// Zone order: StatusRail (4px) · Sidebar · Topbar · PageHeader slot · Content.
// No @junction/core import. All data flows through server functions.

import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router"
import { getRequest } from "@tanstack/react-start/server"
import type { ReactNode } from "react"
import { Toaster } from "sonner"
import { SIDEBAR_COOKIE, SIDEBAR_SCRIPT, Sidebar, type SidebarState } from "../ui/sidebar.js"
import { StatusRail } from "../ui/status-rail.js"
import { TooltipProvider } from "../ui/tooltip.js"
import "../styles/app.css"

// Pre-hydration theme script — reads localStorage and sets data-theme on <html>
// BEFORE first paint, avoiding a flash of wrong theme. Runs as an inline script
// in <head> so it executes synchronously before any React hydration.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("junction-theme");if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`

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
    // Inline scripts run BEFORE React hydration:
    // 1. THEME_SCRIPT: reads localStorage → sets data-theme on <html> (no theme flash).
    // 2. SIDEBAR_SCRIPT: reads cookie → sets data-sidebar on <html> (no width flash).
    scripts: [{ children: THEME_SCRIPT }, { children: SIDEBAR_SCRIPT }],
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

// Read the sidebar cookie during SSR so the initial render emits the correct
// data-sidebar attribute on <html> — preventing a width flash before hydration
// (same pattern as THEME_SCRIPT for theme). Uses the real TanStack Start server
// API: getRequest() is available in SSR context and throws on the client, so
// the try/catch guarantees safe fallback to "expanded" on the client side.
// SIDEBAR_SCRIPT then corrects the attribute from the cookie before hydration.
function getSidebarInitialState(): SidebarState {
  try {
    const cookieHeader = getRequest().headers.get("cookie") ?? ""
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SIDEBAR_COOKIE}=([^;]*)`))
    if (match?.[1] === "collapsed") return "collapsed"
  } catch {
    // Client context / Vite build — getRequest() throws; SIDEBAR_SCRIPT handles client
  }
  return "expanded"
}

function RootDocument({ children }: { readonly children: ReactNode }) {
  const sidebarInitialState = getSidebarInitialState()

  return (
    <html
      lang="en"
      // data-sidebar is set on <html> — same element the SIDEBAR_SCRIPT targets
      // and the CSS [data-sidebar] selectors read. Single source of truth for
      // sidebar collapse state: the attribute on this element drives both the
      // sidebar width (via --sidebar-current) and the content margin-left.
      data-sidebar={sidebarInitialState}
    >
      <head>
        <HeadContent />
      </head>
      <body
        style={{ backgroundColor: "var(--bg)", color: "var(--fg)" }}
        className="font-sans antialiased"
      >
        {/* Skip link — first focusable element for keyboard users */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[var(--z-overlay)] focus:px-3 focus:py-1 focus:rounded-[var(--radius-sm)]"
          style={{ backgroundColor: "var(--accent-fill)", color: "var(--accent-fg)" }}
        >
          Skip to main content
        </a>

        <TooltipProvider>
          {/* Fixed five-zone shell ─────────────────────────────────────────
              Zone 1 · StatusRail — 4px fixed left edge (survives sidebar collapse)
              Zone 2 · Sidebar   — fixed, 15rem expanded / 3rem icon-only
              Zone 3 · Topbar    — sticky context bar (section + global controls)
              Zone 4 · PageHeader slot — per-route, via route components
              Zone 5 · Content   — scrollable, left-aligned in the shell       */}

          {/* Zone 1: StatusRail — 4px fixed far-left, behind sidebar */}
          <aside
            aria-label="Connection status"
            className="fixed left-0 top-0 bottom-0 w-1 flex flex-col py-2"
            style={{
              backgroundColor: "var(--surface-2)",
              zIndex: "var(--z-rail)",
            }}
          >
            <StatusRail segments={STATIC_RAIL_SEGMENTS} className="flex-1 mx-auto" />
          </aside>

          {/* Zone 2: Sidebar — fixed, offset 4px for StatusRail */}
          <Sidebar initialState={sidebarInitialState} />

          {/* Main column — pushed right by the CSS var --sidebar-current which is
              set by the [data-sidebar] selector on <html>. Both zones move together
              via a single attribute flip; no React state/inline-style desync. */}
          <AppShellMain>{children}</AppShellMain>

          {/* Toaster — mounted globally; real usage in inc 24+ mutations */}
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

// AppShellMain — offset content area. margin-left reads var(--sidebar-current)
// which is driven by html[data-sidebar] in app.css. When the sidebar toggles,
// it flips the <html> attribute → CSS recalculates both the sidebar width and
// this margin in one paint; no JS layout listener required.
function AppShellMain({ children }: { readonly children: ReactNode }) {
  return (
    <div
      id="shell-main"
      className="flex flex-col min-h-screen"
      style={{
        // 4px (StatusRail) + var(--sidebar-current) set by [data-sidebar] selector.
        // Both sidebar width and this margin read the same token so they move together.
        marginLeft: "calc(4px + var(--sidebar-current))",
        // Transition is motion-gated via app.css @media prefers-reduced-motion.
        transition: "margin-left var(--motion-short) var(--ease-enter)",
      }}
    >
      {/* Zone 3: Topbar — thin context bar, sticky */}
      <Topbar />

      {/* Zone 4+5: Page content (includes PageHeader + scrollable Content).
          Routes render PageHeader themselves; main is the scroll container. */}
      <main
        id="main-content"
        className="flex-1 px-[var(--gutter)] py-6"
        style={{ maxWidth: "var(--content-max)" }}
      >
        {children}
      </main>
    </div>
  )
}

// Zone 3: Topbar — sticky thin context bar.
// Left: section name (breadcrumb placeholder; full breadcrumb deferred to detail pages).
// Right: global slot (reserved for inc 24+ controls).
function Topbar() {
  const matches = useRouterState({ select: (s) => s.matches })
  // Derive section label from the deepest matched route path.
  const currentPath = matches.at(-1)?.routeId ?? "/"
  const sectionLabel = routeToSection(currentPath)

  return (
    <header
      className="sticky top-0 flex items-center justify-between shrink-0 px-[var(--gutter)] border-b"
      style={{
        height: "var(--topbar-height)",
        backgroundColor: "var(--surface)",
        borderColor: "var(--border)",
        zIndex: "var(--z-topbar)",
      }}
    >
      {/* Left: breadcrumb / section name */}
      <nav aria-label="Breadcrumb">
        <ol className="flex items-center gap-1.5 list-none m-0 p-0">
          <li>
            <span
              style={{
                fontSize: "var(--text-body)",
                color: "var(--muted)",
                fontWeight: 500,
              }}
            >
              {sectionLabel}
            </span>
          </li>
        </ol>
      </nav>

      {/* Right: global slot — reserved for inc 24+ */}
      <div />
    </header>
  )
}

function routeToSection(routeId: string): string {
  if (routeId === "/" || routeId === "__root__") return "Dashboard"
  if (routeId.includes("platforms")) return "Platforms"
  if (routeId.includes("credentials")) return "Credentials"
  if (routeId.includes("profiles")) return "Profiles"
  return "Junction"
}
