// SPDX-License-Identifier: AGPL-3.0-only
// PageHeader — per-route band: title (--text-h1) + count chip + optional actions slot.
// B2: title row is baseline-aligned (items-baseline); count chip uses neutral variant
// so it reads as a count, not a status signal; subtitle uses --gray-700 per spec;
// actions align to the title row top (items-start on outer flex).
// Used by all list routes.

import type { ReactNode } from "react"
import { Badge } from "./badge.js"
import { cn } from "./cn.js"

interface PageHeaderProps {
  readonly title: string
  readonly count?: number
  readonly subtitle?: string
  readonly actions?: ReactNode
  readonly className?: string
}

export function PageHeader({ title, count, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4 pb-6", className)}>
      <div className="flex flex-col gap-1 min-w-0">
        {/* Title row: center-aligned — the count chip is a fixed-height pill, so optical
            center against the 24px h1 reads correctly (baseline-align dropped the pill
            visibly low next to the large heading — agentation feedback). */}
        <div className="flex items-center gap-2.5">
          <h1
            style={{
              fontSize: "var(--text-h1)",
              fontWeight: 600,
              color: "var(--gray-1000)",
              margin: 0,
              lineHeight: 1.25,
            }}
          >
            {title}
          </h1>
          {count !== undefined && (
            // neutral variant: a quiet count chip, not a status badge (B4 decision)
            <Badge variant="neutral" aria-label={`${count} ${title.toLowerCase()}`}>
              {count}
            </Badge>
          )}
        </div>
        {/* Subtitle/lede: --gray-700 per spec (B2) */}
        {subtitle && (
          <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
            {subtitle}
          </p>
        )}
      </div>

      {/* Actions: shrink-0 keeps them right-aligned, aligned to title row top via items-start */}
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

export function PageHeaderSkeleton({ className }: { readonly className?: string }) {
  return (
    <div
      className={cn("pb-6 flex items-start justify-between gap-4", className)}
      aria-hidden="true"
    >
      <div className="flex flex-col gap-1">
        <div
          className="rounded-[var(--radius-6)] motion-safe:animate-pulse"
          style={{ height: "1.5rem", width: "160px", backgroundColor: "var(--gray-100)" }}
        />
        <div
          className="rounded-[var(--radius-6)] motion-safe:animate-pulse"
          style={{
            height: "0.875rem",
            width: "100px",
            opacity: 0.6,
            backgroundColor: "var(--gray-100)",
          }}
        />
      </div>
    </div>
  )
}
