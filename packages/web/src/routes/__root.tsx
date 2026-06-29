// SPDX-License-Identifier: AGPL-3.0-only
// Root route — document shell, fixed app shell, Toaster.
// Status-rail RETIRED in inc 24.5 — route-row is the new signature element.
// No @junction/core import. All data flows through server functions.

import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Toaster } from "sonner"
import type { SystemInfo } from "../server/data.functions.js"
import { getSidebarState, getSystemInfo } from "../server/data.functions.js"
import { DevAgentation } from "../ui/dev-agentation.js"
import { SIDEBAR_SCRIPT, Sidebar, type SidebarState } from "../ui/sidebar.js"
import { TooltipProvider } from "../ui/tooltip.js"
import "../styles/app.css"

// Pre-hydration theme script — A1: light|dark only, default dark.
// If an explicit preference is stored in localStorage, use it.
// Otherwise seed from OS prefers-color-scheme ONCE (without persisting) so an
// unset user gets their OS pref on first visit; default dark when no OS signal.
// Never sets a "system" value — always a concrete light|dark on data-theme.
const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem("junction-theme");if(s==="light"||s==="dark"){document.documentElement.setAttribute("data-theme",s)}else{var d=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.setAttribute("data-theme",d)}}catch(e){document.documentElement.setAttribute("data-theme","dark")}})()`

export const Route = createRootRoute({
  // Read the sidebar cookie + system info in parallel so the initial SSR render
  // has both without an extra round-trip. getSystemInfo degrades gracefully
  // (the label helpers return "unavailable (...)" strings) so this never throws.
  beforeLoad: async (): Promise<{
    readonly sidebarState: SidebarState
    readonly systemInfo: SystemInfo
  }> => {
    const [sidebarState, systemInfo] = await Promise.all([getSidebarState(), getSystemInfo()])
    return { sidebarState, systemInfo }
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Junction" },
    ],
    // Neutral J favicon (SVG, inlined). serve.mjs serves no static /, so favicon
    // must be inlined to avoid browser /favicon.ico probe (inc-22 gotcha).
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E" +
          "%3Crect width='32' height='32' rx='6' fill='%23171717'/%3E" +
          "%3Ctext x='50%25' y='50%25' dominant-baseline='central' text-anchor='middle' " +
          "font-family='system-ui,sans-serif' font-size='18' font-weight='700' fill='%23ffffff'%3EJ%3C/text%3E" +
          "%3C/svg%3E",
      },
    ],
    // Inline scripts run BEFORE React hydration:
    // 1. THEME_SCRIPT: reads localStorage → sets data-theme on <html>.
    // 2. SIDEBAR_SCRIPT: reads cookie → sets data-sidebar on <html>.
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

function RootDocument({ children }: { readonly children: ReactNode }) {
  const { sidebarState: sidebarInitialState, systemInfo } = Route.useRouteContext()

  return (
    <html
      lang="en"
      // data-sidebar on <html> is the single source of truth for sidebar collapse:
      // SIDEBAR_SCRIPT sets it pre-hydration from cookie; CSS [data-sidebar] selectors
      // drive --sidebar-current which both sidebar width and content margin-left read.
      data-sidebar={sidebarInitialState}
    >
      <head>
        <HeadContent />
      </head>
      <body
        style={{ backgroundColor: "var(--bg-100)", color: "var(--gray-1000)" }}
        className="font-sans antialiased"
      >
        {/* Skip link — first focusable element for keyboard users */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[var(--z-overlay)] focus:px-3 focus:py-1 focus:rounded-[var(--radius-6)]"
          style={{ backgroundColor: "var(--gray-1000)", color: "var(--bg-100)" }}
        >
          Skip to main content
        </a>

        <TooltipProvider>
          {/* App shell: Sidebar (fixed) + main content column */}

          {/* Sidebar — fixed, no StatusRail offset (rail retired inc 24.5) */}
          <Sidebar initialState={sidebarInitialState} systemInfo={systemInfo} />

          {/* Main column — margin-left driven by --sidebar-current CSS var
              which is set by [data-sidebar] on <html> (app.css). Atomic toggle,
              no JS layout listener, no transition on layout properties. */}
          <AppShellMain>{children}</AppShellMain>

          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-body)",
                background: "var(--bg-100)",
                color: "var(--gray-1000)",
                border: "1px solid var(--alpha-400)",
                borderRadius: "var(--radius-12)",
                boxShadow: "var(--shadow-md)",
              },
            }}
          />
        </TooltipProvider>

        {/* agentation UI-annotation overlay — DEV-ONLY (stripped from prod builds). */}
        <DevAgentation />

        <Scripts />
      </body>
    </html>
  )
}

// AppShellMain — offset content area.
// margin-left reads var(--sidebar-current) driven by html[data-sidebar] in app.css.
// No StatusRail offset: content starts at sidebar edge (rail retired inc 24.5).
function AppShellMain({ children }: { readonly children: ReactNode }) {
  return (
    <div
      id="shell-main"
      className="flex flex-col min-h-screen"
      style={{
        // var(--sidebar-current) set by [data-sidebar] selector in app.css.
        // No +4px rail offset — StatusRail retired inc 24.5.
        marginLeft: "var(--sidebar-current)",
      }}
    >
      {/* Page content — routes render PageHeader + scrollable content inside main.
          inc 24.6: maxWidth raised to --content-max (76rem/1216px) so content
          uses the available width; scrollbar-gutter prevents layout shift.
          inc 25: the empty Topbar was removed so the page heading sits at the top
          (no empty band). The <main> top padding is a small, intentional gutter. */}
      <main
        id="main-content"
        className="flex-1 px-[var(--gutter)] pt-[var(--gutter)] pb-8"
        style={{ maxWidth: "var(--content-max)", scrollbarGutter: "stable" }}
      >
        {children}
      </main>
    </div>
  )
}
