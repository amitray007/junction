// SPDX-License-Identifier: AGPL-3.0-only
// PageHeader — per-route band: title + count chip + optional subtitle + actions slot.
// Used by all four list routes (Dashboard, Platforms, Credentials, Profiles).
// Reserve its height during load via the skeleton variant.

import type { ReactNode } from "react"
import { Badge } from "./badge.js"
import { cn } from "./cn.js"

interface PageHeaderProps {
  /** Main page title (--text-page-title, 20px 600). */
  readonly title: string
  /** Optional count to render as a muted chip next to the title. */
  readonly count?: number
  /** Optional subtitle below the title. */
  readonly subtitle?: string
  /** Right-aligned actions slot (search / filter / primary action). */
  readonly actions?: ReactNode
  readonly className?: string
}

export function PageHeader({ title, count, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4", "pb-6", className)}>
      <div className="flex flex-col gap-1 min-w-0">
        {/* Title row: heading + count chip */}
        <div className="flex items-baseline gap-2.5">
          <h1
            style={{
              fontSize: "var(--text-page-title)",
              fontWeight: 600,
              letterSpacing: "var(--tracking-tight)",
              color: "var(--fg)",
              margin: 0,
              lineHeight: 1.25,
            }}
          >
            {title}
          </h1>
          {count !== undefined && (
            <Badge variant="configured" aria-label={`${count} ${title.toLowerCase()}`}>
              {count}
            </Badge>
          )}
        </div>
        {/* Optional subtitle */}
        {subtitle && (
          <p
            style={{
              fontSize: "var(--text-body)",
              color: "var(--muted)",
              margin: 0,
            }}
          >
            {subtitle}
          </p>
        )}
      </div>

      {/* Actions slot — right-aligned */}
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

// Skeleton placeholder that occupies the same height as a loaded PageHeader,
// preventing vertical reflow when the route data arrives.
export function PageHeaderSkeleton({ className }: { readonly className?: string }) {
  return (
    <div
      className={cn("pb-6 flex items-start justify-between gap-4", className)}
      aria-hidden="true"
    >
      <div className="flex flex-col gap-1">
        {/* Title placeholder */}
        <div
          className="rounded-[var(--radius-sm)] bg-[var(--surface-2)] motion-safe:animate-pulse"
          style={{ height: "1.5rem", width: "160px" }}
        />
        {/* Subtitle placeholder */}
        <div
          className="rounded-[var(--radius-sm)] bg-[var(--surface-2)] motion-safe:animate-pulse"
          style={{ height: "0.875rem", width: "100px", opacity: 0.6 }}
        />
      </div>
    </div>
  )
}
