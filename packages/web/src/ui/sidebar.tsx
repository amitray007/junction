// SPDX-License-Identifier: AGPL-3.0-only
// Sidebar shell — fixed app shell component.
// Active state: gray-100 bg + gray-1000 text. NO side-accent stripe (anti-slop rule).
// Collapse via Cmd/Ctrl+B; persisted via cookie for SSR no-flash.
// No @junction/core import.

import { Link, useLocation } from "@tanstack/react-router"
import {
  Database,
  Key,
  LayoutList,
  type LucideIcon,
  Monitor,
  Moon,
  Server,
  Sun,
} from "lucide-react"
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { cn } from "./cn.js"
import { Kbd } from "./kbd.js"
import { Tooltip } from "./tooltip.js"
import { Wordmark } from "./wordmark.js"

// ─── Cookie helpers ───────────────────────────────────────────────────────────
// Sidebar collapse state is persisted in a cookie (not localStorage) so SSR
// can read it and render the correct initial width before hydration.

export const SIDEBAR_COOKIE = "junction-sidebar"
export type SidebarState = "expanded" | "collapsed"

function readSidebarCookie(): SidebarState {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${SIDEBAR_COOKIE}=([^;]*)`))
    if (match?.[1] === "collapsed") return "collapsed"
  } catch {
    // ignore (SSR / private browsing)
  }
  return "expanded"
}

function writeSidebarCookie(state: SidebarState) {
  try {
    const maxAge = 365 * 24 * 60 * 60
    // biome-ignore lint/suspicious/noDocumentCookie: intentional — SSR-safe cookie persistence for sidebar state
    document.cookie = `${SIDEBAR_COOKIE}=${state}; path=/; max-age=${maxAge}; SameSite=Lax`
  } catch {
    // ignore
  }
}

// Pre-hydration sidebar script — reads cookie, sets data-sidebar on <html> BEFORE
// first paint. SIDEBAR_SCRIPT targets document.documentElement (<html>), matching
// app.css [data-sidebar] selectors and the toggle handler below.
export const SIDEBAR_SCRIPT = `(function(){try{var m=document.cookie.match(/(^|;\\s*)junction-sidebar=([^;]*)/);var s=m&&m[2]==="collapsed"?"collapsed":"expanded";document.documentElement.setAttribute("data-sidebar",s)}catch(e){}})()`

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

// CONNECT group reserved for inc 24+.
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
        "rounded-[var(--radius-6)]",
        "transition-colors duration-[var(--motion-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
        collapsed ? "justify-center w-9 h-9" : "px-2.5 h-9 w-full",
        isActive
          ? // Active: gray-100 bg + gray-1000 text — NO side-accent stripe (anti-slop rule)
            "bg-[var(--gray-100)] text-[var(--gray-1000)] font-medium"
          : "text-[var(--gray-700)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-1000)]",
      )}
    >
      <Icon
        className="shrink-0 h-4 w-4"
        aria-hidden="true"
        style={{ color: isActive ? "var(--gray-1000)" : undefined }}
      />
      {!collapsed && (
        <span
          className="leading-none truncate"
          style={{
            fontSize: "var(--text-label)",
            color: isActive ? "var(--gray-1000)" : undefined,
          }}
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
          className="px-2.5 mb-1 select-none"
          style={{
            fontSize: "var(--text-caption)",
            color: "var(--gray-600)",
            fontWeight: 500,
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

// ─── Theme toggle ─────────────────────────────────────────────────────────────

type ThemePreference = "system" | "light" | "dark"

const THEME_CYCLE: ThemePreference[] = ["system", "light", "dark"]
const THEME_LABEL: Record<ThemePreference, string> = {
  system: "Theme: System",
  light: "Theme: Light",
  dark: "Theme: Dark",
}
const THEME_ICON: Record<ThemePreference, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

// Theme preference: useSyncExternalStore is the SSR-safe primitive for localStorage.
// getServerSnapshot returns "system" matching SSR + THEME_SCRIPT default — no flash.
const themeListeners = new Set<() => void>()

function readStoredTheme(): ThemePreference {
  try {
    const v = localStorage.getItem("junction-theme")
    if (v === "light" || v === "dark") return v
  } catch {
    // no localStorage (SSR or private browsing)
  }
  return "system"
}

function subscribeTheme(cb: () => void): () => void {
  themeListeners.add(cb)
  return () => themeListeners.delete(cb)
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
  for (const cb of themeListeners) cb()
}

function ThemeToggle({ collapsed }: { readonly collapsed: boolean }) {
  const pref = useSyncExternalStore(
    subscribeTheme,
    readStoredTheme,
    () => "system" as ThemePreference,
  )

  function toggle() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(pref) + 1) % THEME_CYCLE.length] ?? "system"
    applyTheme(next)
  }

  const Icon = THEME_ICON[pref]

  const btn = (
    <button
      type="button"
      aria-label={THEME_LABEL[pref]}
      onClick={toggle}
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        "rounded-[var(--radius-6)] border border-[var(--alpha-400)]",
        "transition-colors duration-[var(--motion-fast)]",
        "hover:bg-[var(--gray-100)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
        "w-9 h-9",
      )}
      style={{
        backgroundColor: "transparent",
        color: "var(--gray-700)",
        cursor: "pointer",
      }}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  )

  if (collapsed) {
    return <Tooltip content={THEME_LABEL[pref]}>{btn}</Tooltip>
  }
  return btn
}

// ─── Sidebar component ────────────────────────────────────────────────────────

interface SidebarProps {
  readonly initialState?: SidebarState
  readonly children?: ReactNode
}

export function Sidebar({ initialState }: SidebarProps) {
  // Initial state from SSR (getSidebarState → route context → initialState) AND from
  // SIDEBAR_SCRIPT, which set html[data-sidebar] from the cookie before hydration.
  // Lazy initializer runs once — no mount-effect flash.
  const [collapsed, setCollapsed] = useState(
    () => (initialState ?? readSidebarCookie()) === "collapsed",
  )

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      const state: SidebarState = next ? "collapsed" : "expanded"
      writeSidebarCookie(state)
      // Single attribute flip on <html> drives BOTH sidebar width AND content margin
      // via [data-sidebar] CSS selectors in app.css (--sidebar-current token).
      document.documentElement.setAttribute("data-sidebar", state)
      return next
    })
  }, [])

  // Cmd/Ctrl+B — bail when focus is inside an editable control.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "b") return
      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      toggle()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [toggle])

  const width = collapsed ? "var(--sidebar-width-icon)" : "var(--sidebar-width)"

  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        "fixed top-0 bottom-0 left-0",
        "flex flex-col",
        "border-r border-[var(--alpha-400)]",
        "overflow-hidden",
      )}
      style={{
        width,
        minWidth: width,
        zIndex: "var(--z-sidebar)",
        backgroundColor: "var(--bg-100)",
      }}
    >
      {/* Header: wordmark */}
      <div
        className={cn(
          "flex items-center shrink-0 border-b border-[var(--alpha-400)]",
          collapsed
            ? "justify-center h-[var(--topbar-height)] px-0"
            : "px-3 h-[var(--topbar-height)]",
        )}
      >
        <Link
          to="/"
          aria-label="Junction dashboard"
          className="flex items-center no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1 rounded-[var(--radius-6)]"
        >
          {collapsed ? (
            // Collapsed: J glyph only
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "20px",
                height: "20px",
                borderRadius: "var(--radius-6)",
                backgroundColor: "var(--gray-1000)",
                color: "var(--bg-100)",
                fontFamily: "var(--font-sans)",
                fontSize: "12px",
                fontWeight: 700,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              J
            </span>
          ) : (
            <Wordmark />
          )}
        </Link>
      </div>

      {/* Nav content */}
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

      {/* Footer: theme toggle + ⌘B hint */}
      <div
        className={cn(
          "shrink-0 border-t border-[var(--alpha-400)]",
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
                fontSize: "var(--text-caption)",
                color: "var(--gray-600)",
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
                    "rounded-[var(--radius-6)]",
                    "transition-colors duration-[var(--motion-fast)]",
                    "hover:bg-[var(--gray-100)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
                    "px-1.5 h-6",
                  )}
                  style={{ color: "var(--gray-700)", backgroundColor: "transparent" }}
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
                "w-9 h-9 rounded-[var(--radius-6)]",
                "transition-colors duration-[var(--motion-fast)]",
                "hover:bg-[var(--gray-100)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
              )}
              style={{ color: "var(--gray-700)", backgroundColor: "transparent" }}
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
