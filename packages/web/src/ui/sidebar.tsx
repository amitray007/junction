// SPDX-License-Identifier: AGPL-3.0-only
// Sidebar shell — fixed app shell component.
// Active state: gray-100 bg + gray-1000 text. NO side-accent stripe (anti-slop rule).
// Collapse via Cmd/Ctrl+B; persisted via cookie for SSR no-flash.
// Theme: light|dark only (no "system") — default dark, OS-pref seeded on first visit.
// No @junction/core import.

import { Link, useLocation } from "@tanstack/react-router"
import {
  Database,
  HardDrive,
  Key,
  LayoutDashboard,
  type LucideIcon,
  Moon,
  PanelLeft,
  PanelLeftClose,
  ScrollText,
  Server,
  Settings,
  Sun,
} from "lucide-react"
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react"
import type { SystemInfo } from "../server/data.functions.js"
import { cn } from "./cn.js"
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

// Group 1: top — Dashboard + Settings (no "Manage" eyebrow — A6/A7)
const NAV_TOP: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/audit", label: "Audit", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings },
]

// Group 2: platforms + data items
const NAV_DATA: NavItem[] = [
  { to: "/platforms", label: "Platforms", icon: Server },
  { to: "/profiles", label: "Profiles", icon: Database },
  { to: "/credentials", label: "Credentials", icon: Key },
]

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
// A6/A7: no "Manage" eyebrow label. Groups are separated by a subtle hairline.

function NavGroup({
  items,
  collapsed,
}: {
  readonly items: NavItem[]
  readonly collapsed: boolean
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => (
        <SidebarNavLink key={item.to} item={item} collapsed={collapsed} />
      ))}
    </div>
  )
}

// Hairline separator between nav groups — alpha-200, subtle.
function NavGroupSeparator({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <div
      aria-hidden="true"
      style={{
        height: "1px",
        backgroundColor: "var(--alpha-200)",
        margin: collapsed ? "4px 6px" : "4px 0",
      }}
    />
  )
}

// ─── Theme toggle ─────────────────────────────────────────────────────────────
// A1: light|dark only (no "system"). Default = dark. First-paint seeds from OS
// prefers-color-scheme once (without persisting), then explicit after user toggle.

export type ThemePreference = "light" | "dark"

const THEME_LABEL: Record<ThemePreference, string> = {
  light: "Theme: Light",
  dark: "Theme: Dark",
}
const THEME_ICON: Record<ThemePreference, LucideIcon> = {
  light: Sun,
  dark: Moon,
}

// Theme preference: useSyncExternalStore is the SSR-safe primitive for localStorage.
// getServerSnapshot returns "dark" — the SSR/no-JS default.
const themeListeners = new Set<() => void>()

export function readStoredTheme(): ThemePreference {
  try {
    const v = localStorage.getItem("junction-theme")
    if (v === "light" || v === "dark") return v
    // No explicit preference stored — THEME_SCRIPT already set data-theme from
    // OS prefers-color-scheme. Mirror what the script applied so the toggle label
    // matches the rendered theme on first paint (FIX 2: OS-light first-visit desync).
    const applied = document.documentElement.getAttribute("data-theme")
    if (applied === "light" || applied === "dark") return applied
    // Fall back to OS preference, then dark.
    if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light"
  } catch {
    // no localStorage / document (SSR or private browsing)
  }
  return "dark"
}

function subscribeTheme(cb: () => void): () => void {
  themeListeners.add(cb)
  return () => themeListeners.delete(cb)
}

export function applyTheme(pref: ThemePreference) {
  try {
    document.documentElement.setAttribute("data-theme", pref)
    localStorage.setItem("junction-theme", pref)
  } catch {
    // ignore
  }
  for (const cb of themeListeners) cb()
}

// ThemeToggle — flips light↔dark (canonical theme control).
//   collapsed: icon-only square + tooltip (sidebar collapsed state).
//   withLabel: wider button showing the icon + the current theme label
//     ("Light"/"Dark") — used as the Settings "Appearance" control.
export function ThemeToggle({
  collapsed,
  withLabel = false,
}: {
  readonly collapsed: boolean
  readonly withLabel?: boolean
}) {
  const pref = useSyncExternalStore(subscribeTheme, readStoredTheme, () => "dark" as const)

  function toggle() {
    applyTheme(pref === "light" ? "dark" : "light")
  }

  const Icon = THEME_ICON[pref]

  if (withLabel) {
    return (
      <button
        type="button"
        aria-label={THEME_LABEL[pref]}
        onClick={toggle}
        className={cn(
          "inline-flex items-center gap-2 shrink-0",
          "rounded-[var(--radius-6)] border border-[var(--alpha-400)]",
          "transition-colors duration-[var(--motion-fast)]",
          "hover:bg-[var(--gray-100)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
          "h-[var(--control-height)] px-3",
        )}
        style={{
          backgroundColor: "transparent",
          color: "var(--gray-1000)",
          cursor: "pointer",
        }}
      >
        <Icon className="h-4 w-4" aria-hidden="true" style={{ color: "var(--gray-700)" }} />
        <span style={{ fontSize: "var(--text-body)" }}>
          {/* Show the CURRENT theme; clicking switches to the other. */}
          {pref === "light" ? "Light" : "Dark"}
        </span>
      </button>
    )
  }

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

// ─── System panel ─────────────────────────────────────────────────────────────
// Pinned between nav and footer. Expanded: three quiet label/value rows.
// Collapsed: a single icon button whose tooltip contains all three values.
// If systemInfo is undefined, renders nothing.

function SidebarSystemPanel({
  systemInfo,
  collapsed,
}: {
  readonly systemInfo: SystemInfo
  readonly collapsed: boolean
}) {
  if (collapsed) {
    const tooltipContent = (
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div>
          <span style={{ color: "var(--gray-600)", marginRight: "6px" }}>Store</span>
          {systemInfo.credentialStore}
        </div>
        <div>
          <span style={{ color: "var(--gray-600)", marginRight: "6px" }}>Sandbox</span>
          {systemInfo.sandbox}
        </div>
        <div>
          <span style={{ color: "var(--gray-600)", marginRight: "6px" }}>Home</span>
          {systemInfo.home}
        </div>
      </div>
    )
    return (
      <div
        style={{
          borderTop: "1px solid var(--alpha-200)",
          padding: "8px 6px",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <Tooltip content={tooltipContent} delayDuration={300}>
          <button
            type="button"
            aria-label="System info"
            className={cn(
              "inline-flex items-center justify-center",
              "w-9 h-9 rounded-[var(--radius-6)]",
              "transition-colors duration-[var(--motion-fast)]",
              "hover:bg-[var(--gray-100)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
            )}
            style={{ color: "var(--gray-600)", backgroundColor: "transparent", cursor: "default" }}
          >
            <HardDrive className="h-4 w-4" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    )
  }

  return (
    <div style={{ padding: "8px" }}>
      <section
        aria-label="System"
        style={{
          // Overall border around the panel (feedback) — a contained card, not just a
          // top hairline.
          border: "1px solid var(--alpha-400)",
          borderRadius: "var(--radius-6)",
          background: "var(--bg-100)",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <SystemInfoRow label="Store" value={systemInfo.credentialStore} />
        <SystemInfoRow label="Sandbox" value={systemInfo.sandbox} />
        <SystemInfoRow label="Home" value={systemInfo.home} mono />
      </section>
    </div>
  )
}

// A stacked label/value pair: the label on its own line, the value below it.
// The value wraps (break-word) so long paths/strings show fully, not truncated.
function SystemInfoRow({
  label,
  value,
  mono = false,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <span
        style={{
          fontSize: "var(--text-caption)",
          color: "var(--gray-600)",
          fontWeight: 500,
        }}
      >
        {label}
      </span>
      <span
        title={value}
        style={{
          fontSize: mono ? "var(--text-mono)" : "var(--text-caption)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          color: "var(--gray-900)",
          wordBreak: "break-word",
          lineHeight: 1.35,
        }}
      >
        {value}
      </span>
    </div>
  )
}

// ─── Sidebar component ────────────────────────────────────────────────────────

interface SidebarProps {
  readonly initialState?: SidebarState
  readonly systemInfo?: SystemInfo
  readonly children?: ReactNode
}

export function Sidebar({ initialState, systemInfo }: SidebarProps) {
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
            : "px-2 py-3 flex flex-col gap-1",
        )}
      >
        {/* Group 1: Dashboard + Settings */}
        <NavGroup items={NAV_TOP} collapsed={collapsed} />
        {/* Subtle hairline group separator — no eyebrow label (A6) */}
        <NavGroupSeparator collapsed={collapsed} />
        {/* Group 2: Platforms + Profiles + Credentials */}
        <NavGroup items={NAV_DATA} collapsed={collapsed} />
      </nav>

      {/* System panel — pinned above footer; renders nothing when systemInfo is absent */}
      {systemInfo !== undefined && (
        <SidebarSystemPanel systemInfo={systemInfo} collapsed={collapsed} />
      )}

      {/* Footer: theme toggle + ⌘B hint. When the System card is shown it already
          separates the footer from the nav, so no top border (a second edge-to-edge line
          read as clunky — feedback). Only when there's no System card do we keep a border. */}
      <div
        className={cn(
          "shrink-0",
          systemInfo === undefined && "border-t border-[var(--alpha-400)]",
          collapsed
            ? "px-1.5 pb-3 pt-1 flex flex-col items-center gap-2"
            : "px-3 pb-3 pt-1 flex items-center gap-2",
        )}
      >
        <ThemeToggle collapsed={collapsed} />
        {!collapsed && (
          <div className="flex flex-1 items-center justify-end shrink-0">
            <Tooltip content="Collapse sidebar (⌘B)">
              <button
                type="button"
                aria-label="Collapse sidebar"
                onClick={toggle}
                className={cn(
                  "inline-flex items-center justify-center",
                  "w-8 h-8 rounded-[var(--radius-6)]",
                  "transition-colors duration-[var(--motion-fast)]",
                  "hover:bg-[var(--gray-100)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
                )}
                style={{ color: "var(--gray-700)", backgroundColor: "transparent" }}
              >
                <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        )}
        {collapsed && (
          <Tooltip content="Expand sidebar (⌘B)">
            <button
              type="button"
              aria-label="Expand sidebar"
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
              <PanelLeft className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
    </aside>
  )
}
