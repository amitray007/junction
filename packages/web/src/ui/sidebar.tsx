// SPDX-License-Identifier: AGPL-3.0-only
// Sidebar shell — fixed 5-zone app shell component (shadcn pattern, OUR tokens).
// Grouped nav (MANAGE/CONNECT), wordmark header, theme toggle + ⌘B hint footer.
// Collapse via Cmd/Ctrl+B; persisted by SIDEBAR_COOKIE read server-side for SSR
// (no width flash on reload — mirrors the THEME_SCRIPT approach).
// No @junction/core import.

import { Link, useLocation } from "@tanstack/react-router"
import { Database, Key, LayoutList, type LucideIcon, Server } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import { cn } from "./cn.js"
import { Kbd } from "./kbd.js"
import { Tooltip } from "./tooltip.js"
import { Wordmark } from "./wordmark.js"

// ─── Cookie helpers ───────────────────────────────────────────────────────────
// The sidebar collapse state is persisted in a cookie (not localStorage) so SSR
// can read it and render the correct initial width before hydration — preventing
// the flash of wrong width that a useEffect/localStorage approach would cause.

export const SIDEBAR_COOKIE = "junction-sidebar"
export type SidebarState = "expanded" | "collapsed"

/** Reads the sidebar cookie from document.cookie (client only). */
function readSidebarCookie(): SidebarState {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${SIDEBAR_COOKIE}=([^;]*)`))
    if (match?.[1] === "collapsed") return "collapsed"
  } catch {
    // ignore (SSR / private browsing)
  }
  return "expanded"
}

/** Writes the sidebar cookie (client only, 1-year expiry, SameSite=Lax). */
function writeSidebarCookie(state: SidebarState) {
  try {
    const maxAge = 365 * 24 * 60 * 60
    // biome-ignore lint/suspicious/noDocumentCookie: intentional — SSR-safe cookie persistence for sidebar state
    document.cookie = `${SIDEBAR_COOKIE}=${state}; path=/; max-age=${maxAge}; SameSite=Lax`
  } catch {
    // ignore
  }
}

// Pre-hydration sidebar script — reads the cookie and sets the data-sidebar
// attribute on <body> BEFORE first paint, so the initial width is correct.
// The SSR render uses the server-read cookie; this script just ensures the
// attribute is set even if SSR didn't set it (safety net).
export const SIDEBAR_SCRIPT = `(function(){try{var m=document.cookie.match(/(^|;\\s*)junction-sidebar=([^;]*)/);var s=m&&m[2]==="collapsed"?"collapsed":"expanded";document.body.setAttribute("data-sidebar",s)}catch(e){}})()`

// ─── Nav structure ────────────────────────────────────────────────────────────

interface NavItem {
  readonly to: string
  readonly label: string
  readonly icon: LucideIcon
}

const MANAGE_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutList },
  { to: "/platforms", label: "Platforms", icon: Server },
  { to: "/credentials", label: "Credentials", icon: Key },
  { to: "/profiles", label: "Profiles", icon: Database },
]

// CONNECT group — reserved for MCP Sources and future destinations (inc 24+).
// Rendered as a structural placeholder until those routes exist.
const CONNECT_ITEMS: NavItem[] = []

// ─── Nav link ─────────────────────────────────────────────────────────────────

function SidebarNavLink({
  item,
  collapsed,
}: {
  readonly item: NavItem
  readonly collapsed: boolean
}) {
  const location = useLocation()
  // "/" matches only root; others match by prefix
  const isActive =
    item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to)
  const Icon = item.icon

  const link = (
    <Link
      to={item.to}
      aria-label={collapsed ? item.label : undefined}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5",
        "rounded-[var(--radius-sm)]",
        "transition-colors duration-[var(--motion-micro)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
        collapsed ? "justify-center w-9 h-9" : "px-2.5 h-9 w-full",
        isActive
          ? "bg-[var(--surface-2)] text-[var(--fg)] font-medium"
          : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]",
      )}
      style={
        isActive
          ? {
              // 2px amber inset-left bar — active nav treatment (NOT amber text)
              boxShadow: "inset 2px 0 0 var(--accent)",
            }
          : undefined
      }
    >
      <Icon
        className="shrink-0 h-4 w-4"
        aria-hidden="true"
        style={{ color: isActive ? "var(--accent)" : undefined }}
      />
      {!collapsed && (
        <span
          className="text-[var(--text-body)] leading-none truncate"
          style={{ color: isActive ? "var(--fg)" : undefined }}
        >
          {item.label}
        </span>
      )}
    </Link>
  )

  if (collapsed) {
    return (
      <Tooltip content={item.label} delayDuration={300}>
        {link}
      </Tooltip>
    )
  }
  return link
}

// ─── Nav group ────────────────────────────────────────────────────────────────

function NavGroup({
  label,
  items,
  collapsed,
}: {
  readonly label: string
  readonly items: NavItem[]
  readonly collapsed: boolean
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      {!collapsed && (
        <p
          className="px-2.5 mb-1 uppercase select-none"
          style={{
            fontSize: "var(--text-eyebrow)",
            fontFamily: "var(--font-mono)",
            fontWeight: 500,
            letterSpacing: "var(--tracking-eyebrow)",
            color: "var(--muted)",
          }}
        >
          {label}
        </p>
      )}
      {items.map((item) => (
        <SidebarNavLink key={item.to} item={item} collapsed={collapsed} />
      ))}
    </div>
  )
}

// ─── Theme toggle (sidebar footer) ───────────────────────────────────────────

type ThemePreference = "system" | "light" | "dark"

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

function readStoredTheme(): ThemePreference {
  try {
    const v = localStorage.getItem("junction-theme")
    if (v === "light" || v === "dark") return v
  } catch {
    // no localStorage (SSR or private browsing)
  }
  return "system"
}

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

function ThemeToggle({ collapsed }: { readonly collapsed: boolean }) {
  const [pref, setPref] = useState<ThemePreference>("system")

  useEffect(() => {
    setPref(readStoredTheme())
  }, [])

  function toggle() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(pref) + 1) % THEME_CYCLE.length] ?? "system"
    applyTheme(next)
    setPref(next)
  }

  const btn = (
    <button
      type="button"
      aria-label={THEME_LABEL[pref]}
      onClick={toggle}
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        "rounded-[var(--radius-sm)] border border-[var(--border)]",
        "transition-colors duration-[var(--motion-micro)]",
        "hover:bg-[var(--surface-2)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
        "w-9 h-9",
      )}
      style={{
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

  if (collapsed) {
    return <Tooltip content={THEME_LABEL[pref]}>{btn}</Tooltip>
  }
  return btn
}

// ─── Sidebar component ────────────────────────────────────────────────────────

interface SidebarProps {
  /** Initial state — read from cookie server-side to prevent SSR flash. */
  readonly initialState?: SidebarState
  readonly children?: ReactNode
}

export function Sidebar({ initialState = "expanded" }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(initialState === "collapsed")

  // On mount, sync from cookie (handles the case where SSR didn't pass initialState).
  useEffect(() => {
    const cookieState = readSidebarCookie()
    setCollapsed(cookieState === "collapsed")
    // Also set the body attribute for CSS consumers.
    document.body.setAttribute("data-sidebar", cookieState)
  }, [])

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      const state: SidebarState = next ? "collapsed" : "expanded"
      writeSidebarCookie(state)
      document.body.setAttribute("data-sidebar", state)
      return next
    })
  }, [])

  // Cmd/Ctrl+B global keyboard shortcut
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [toggle])

  const width = collapsed ? "var(--sidebar-width-icon)" : "var(--sidebar-width)"

  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        "fixed top-0 bottom-0 left-[4px]", // offset by StatusRail width (4px)
        "flex flex-col",
        "border-r border-[var(--border)]",
        "transition-[width] duration-[var(--motion-short)] ease-[var(--ease-enter)]",
        "overflow-hidden",
      )}
      style={{
        width,
        minWidth: width,
        zIndex: "var(--z-sidebar)",
        backgroundColor: "var(--surface)",
      }}
    >
      {/* ── Header: wordmark ───────────────────────────────────────── */}
      <div
        className={cn(
          "flex items-center shrink-0",
          "border-b border-[var(--border)]",
          collapsed
            ? "justify-center h-[var(--topbar-height)] px-0"
            : "px-3 h-[var(--topbar-height)]",
        )}
      >
        <Link
          to="/"
          aria-label="Junction dashboard"
          className="flex items-center no-underline"
          style={{ color: "var(--fg)" }}
        >
          {collapsed ? (
            // When collapsed, show just the amber node
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: "6px",
                height: "6px",
                borderRadius: "0",
                backgroundColor: "var(--accent-fill)",
                flexShrink: 0,
              }}
            />
          ) : (
            <Wordmark />
          )}
        </Link>
      </div>

      {/* ── Nav content ────────────────────────────────────────────── */}
      <nav
        aria-label="Site navigation"
        className={cn(
          "flex-1 overflow-y-auto overflow-x-hidden",
          collapsed
            ? "px-1.5 py-3 flex flex-col items-center gap-1"
            : "px-2 py-3 flex flex-col gap-4",
        )}
      >
        <NavGroup label="Manage" items={MANAGE_ITEMS} collapsed={collapsed} />
        {CONNECT_ITEMS.length > 0 && (
          <NavGroup label="Connect" items={CONNECT_ITEMS} collapsed={collapsed} />
        )}
      </nav>

      {/* ── Footer: theme toggle + status summary + ⌘B hint ────────── */}
      <div
        className={cn(
          "shrink-0 border-t border-[var(--border)]",
          collapsed
            ? "px-1.5 py-3 flex flex-col items-center gap-2"
            : "px-3 py-3 flex items-center gap-2",
        )}
      >
        <ThemeToggle collapsed={collapsed} />
        {!collapsed && (
          <>
            <span
              className="flex-1 truncate"
              style={{
                fontSize: "var(--text-eyebrow)",
                color: "var(--muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              localhost
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <Tooltip content="Toggle sidebar">
                <button
                  type="button"
                  aria-label="Toggle sidebar"
                  onClick={toggle}
                  className={cn(
                    "inline-flex items-center gap-1",
                    "rounded-[var(--radius-sm)]",
                    "transition-colors duration-[var(--motion-micro)]",
                    "hover:bg-[var(--surface-2)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
                    "px-1.5 h-6",
                  )}
                  style={{ color: "var(--muted)", backgroundColor: "transparent" }}
                >
                  <Kbd>⌘B</Kbd>
                </button>
              </Tooltip>
            </div>
          </>
        )}
        {collapsed && (
          <Tooltip content="Toggle sidebar (⌘B)">
            <button
              type="button"
              aria-label="Toggle sidebar"
              onClick={toggle}
              className={cn(
                "inline-flex items-center justify-center",
                "w-9 h-9 rounded-[var(--radius-sm)]",
                "transition-colors duration-[var(--motion-micro)]",
                "hover:bg-[var(--surface-2)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
              )}
              style={{ color: "var(--muted)", backgroundColor: "transparent" }}
            >
              <span aria-hidden="true" style={{ fontSize: "var(--text-body)" }}>
                ›
              </span>
            </button>
          </Tooltip>
        )}
      </div>
    </aside>
  )
}
