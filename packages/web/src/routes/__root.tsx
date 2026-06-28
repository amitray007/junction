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
    // 2. SIDEBAR_SCRIPT: reads cookie → sets data-sidebar on <body> (no width flash).
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

// Read the sidebar cookie during SSR so the initial render matches the persisted
// state — preventing a width flash before hydration (mirrors THEME_SCRIPT).
function getSidebarInitialState(): SidebarState {
  // On the server TanStack Start gives us access to request headers via
  // globalThis.__tss_request_headers (injected by the Start Vite plugin).
  // We parse the Cookie header directly.
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime global injected by TanStack Start SSR
    const headers: Record<string, string> = (globalThis as any).__tss_request_headers ?? {}
    // biome-ignore lint/complexity/useLiteralKeys: headers keys are dynamic HTTP header names
    const cookieHeader = headers["cookie"] ?? headers["Cookie"] ?? ""
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SIDEBAR_COOKIE}=([^;]*)`))
    if (match?.[1] === "collapsed") return "collapsed"
  } catch {
    // SSR context unavailable — fall back to expanded (SIDEBAR_SCRIPT corrects on client)
  }
  return "expanded"
}

function RootDocument({ children }: { readonly children: ReactNode }) {
  const sidebarInitialState = getSidebarInitialState()

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
        style={{ backgroundColor: "var(--bg)", color: "var(--fg)" }}
        className="font-sans antialiased"
        // data-sidebar is set by SIDEBAR_SCRIPT before hydration; React rehydrates it.
        data-sidebar={sidebarInitialState}
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

          {/* Main column — pushed right by sidebar width via margin-left.
              Uses CSS var so it responds to the sidebar width token.
              Both expanded (15rem) and collapsed (3rem + 4px rail) states
              are handled by the transition on the sidebar itself; the margin
              matches the sidebar width at each state via the same token. */}
          <AppShellMain sidebarInitialState={sidebarInitialState}>{children}</AppShellMain>

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

// AppShellMain manages the left-margin offset that keeps content clear of the
// fixed sidebar. We read the router state to know the current sidebar width so
// we can match the CSS transition. The sidebar itself drives the visual width;
// we mirror it with a matching margin transition.
function AppShellMain({
  sidebarInitialState,
  children,
}: {
  readonly sidebarInitialState: SidebarState
  readonly children: ReactNode
}) {
  return <SidebarOffsetMain initialState={sidebarInitialState}>{children}</SidebarOffsetMain>
}

// Client component that reads the sidebar cookie on mount and applies the correct
// left-margin. Transitions match the sidebar width transition so there is no jump.
function SidebarOffsetMain({
  initialState,
  children,
}: {
  readonly initialState: SidebarState
  readonly children: ReactNode
}) {
  // Read data-sidebar attribute that SIDEBAR_SCRIPT sets synchronously.
  // We don't need state here — CSS handles the offset via a data attribute selector.
  // The transition matches sidebar's --motion-short.
  return (
    <div
      className="flex flex-col min-h-screen"
      style={{
        // 4px (StatusRail) + sidebar width. CSS transition matches sidebar.
        marginLeft:
          initialState === "collapsed"
            ? "calc(4px + var(--sidebar-width-icon))"
            : "calc(4px + var(--sidebar-width))",
        transition: `margin-left var(--motion-short) var(--ease-enter)`,
      }}
      // data-sidebar mirrors body[data-sidebar] — a CSS [data-sidebar=collapsed]
      // selector could also drive this, but inline style is simpler and avoids
      // a Tailwind arbitrary-selector for a dynamic value.
      id="shell-main"
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
