// SPDX-License-Identifier: AGPL-3.0-only
// PageHeader — per-route band: title (--text-h1) + count chip + optional actions slot.
// Used by all four list routes.

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
        <div className="flex items-baseline gap-2.5">
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
            <Badge variant="configured" aria-label={`${count} ${title.toLowerCase()}`}>
              {count}
            </Badge>
          )}
        </div>
        {subtitle && (
          <p style={{ fontSize: "var(--text-body)", color: "var(--gray-900)", margin: 0 }}>
            {subtitle}
          </p>
        )}
      </div>

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
