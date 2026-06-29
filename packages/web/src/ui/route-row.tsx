// SPDX-License-Identifier: AGPL-3.0-only
// RouteRow — the signature element.
// Renders: platform → credentialAccount → <ns chip · filter> → on/off
// → separators in gray-400; namespace in blue-bg/blue-text chip; filter mono gray-700.
// Handles: credentialAccount "(none)" → No Auth badge; toolFilter object → compact render.
// Semantic: each row is a <li> in a <ul> (data list, not a clickable trigger).

import type { SourceMeta } from "../server/data.functions.js"
import { StatusBadge } from "./badge.js"
import { cn } from "./cn.js"
import { MonoChip } from "./code.js"

// ─── Tool filter compact render ───────────────────────────────────────────────
// toolFilter is an object { allow?: string[]; deny?: string[] }, never [object Object].

function FilterChip({ toolFilter }: { readonly toolFilter?: SourceMeta["toolFilter"] }) {
  if (!toolFilter) {
    return (
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-mono)",
          color: "var(--gray-600)",
        }}
      >
        All tools
      </span>
    )
  }
  const allowCount = toolFilter.allow?.length ?? 0
  const denyCount = toolFilter.deny?.length ?? 0
  const parts: string[] = []
  if (allowCount > 0) parts.push(`+${allowCount} allow`)
  if (denyCount > 0) parts.push(`−${denyCount} deny`)
  const label = parts.length > 0 ? parts.join(" · ") : "All tools"
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-mono)",
        color: "var(--gray-700)",
      }}
    >
      {label}
    </span>
  )
}

// ─── Separator ────────────────────────────────────────────────────────────────

function Sep() {
  return (
    <span aria-hidden="true" style={{ color: "var(--gray-400)", fontSize: "var(--text-body)" }}>
      →
    </span>
  )
}

// ─── RouteRow ─────────────────────────────────────────────────────────────────

interface RouteRowProps {
  readonly source: SourceMeta
  readonly className?: string
}

export function RouteRow({ source, className }: RouteRowProps) {
  // credentialAccount "(none)" → render as No Auth badge, not the literal string
  const isNoAuth = source.credentialAccount === "(none)"

  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1",
        "py-2 border-b border-[var(--alpha-200)] last:border-0",
        className,
      )}
    >
      {/* Platform */}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-mono)",
          color: "var(--gray-900)",
        }}
      >
        {source.platform}
      </span>

      <Sep />

      {/* Credential account — or No Auth badge */}
      {isNoAuth ? (
        <StatusBadge status="no-auth" />
      ) : (
        <span style={{ fontSize: "var(--text-body)", color: "var(--gray-900)" }}>
          {source.credentialAccount}
        </span>
      )}

      <Sep />

      {/* Namespace chip */}
      <MonoChip>{source.namespace}</MonoChip>

      {/* Filter */}
      <span aria-hidden="true" style={{ color: "var(--gray-400)" }}>
        ·
      </span>
      <FilterChip toolFilter={source.toolFilter} />

      <Sep />

      {/* Enabled / off status */}
      <StatusBadge status={source.enabled ? "configured" : "disabled"} />
    </li>
  )
}
