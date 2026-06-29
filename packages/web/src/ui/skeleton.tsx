// SPDX-License-Identifier: AGPL-3.0-only
// Skeleton — loading placeholder with pulse animation (reduced-motion: static).
// TableSkeleton renders N rows at exactly --row-height-data with matching column widths.

import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-[var(--radius-6)] motion-safe:animate-pulse", className)}
      style={{ backgroundColor: "var(--gray-100)" }}
      {...props}
    />
  )
}

// Convenience: a row of skeleton cells for <tbody> loading states.
// <tr> is not focusable; the parent role="status" owns the a11y announcement.
export function SkeletonRow({ cols = 4 }: { readonly cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }, (_, i) => (
        <td
          // biome-ignore lint/suspicious/noArrayIndexKey: stable static skeleton — no reorder
          key={i}
          className="px-[var(--cell-padding-x)] py-[var(--cell-padding-y)]"
        >
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  )
}

export interface SkeletonColumn {
  readonly width?: string
  readonly flex?: boolean
}

function SkeletonDataRow({
  className,
  cells,
}: {
  readonly className: string
  readonly cells: React.ReactNode
}) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{ height: "var(--row-height-data)", backgroundColor: "var(--bg-100)" }}
    >
      {cells}
    </div>
  )
}

export function TableSkeleton({
  rows = 5,
  columns,
  className,
}: {
  readonly rows?: number
  readonly columns?: SkeletonColumn[]
  readonly className?: string
}) {
  const cols = columns ?? [{ flex: true }, { width: "w-24" }, { width: "w-20" }, { width: "w-16" }]

  return (
    <div
      role="status"
      aria-label="Loading…"
      className={cn(
        "w-full overflow-hidden rounded-[var(--radius-12)] border border-[var(--alpha-400)]",
        className,
      )}
      style={{ boxShadow: "var(--shadow-sm)" }}
    >
      {/* Fake header */}
      <div
        aria-hidden="true"
        className="flex items-center gap-3 border-b border-[var(--alpha-200)] px-[var(--cell-padding-x)]"
        style={{ height: "var(--row-height-header)", backgroundColor: "var(--bg-100)" }}
      >
        {cols.map((col, i) => (
          <Skeleton
            // biome-ignore lint/suspicious/noArrayIndexKey: stable static skeleton — no reorder
            key={i}
            className={cn("h-3", col.flex ? "flex-1" : (col.width ?? "w-20"))}
            style={{ opacity: 0.5 }}
          />
        ))}
      </div>

      {Array.from({ length: rows }, (_, rowIdx) => {
        const rowCls = cn(
          "flex items-center gap-3 border-b border-[var(--alpha-200)] px-[var(--cell-padding-x)]",
          "last:border-0",
        )
        const cells = cols.map((col, colIdx) => (
          <Skeleton
            // biome-ignore lint/suspicious/noArrayIndexKey: stable static skeleton — no reorder
            key={colIdx}
            className={cn("h-4", col.flex ? "flex-1" : (col.width ?? "w-20"))}
          />
        ))
        // biome-ignore lint/suspicious/noArrayIndexKey: stable static skeleton rows
        return <SkeletonDataRow key={rowIdx} className={rowCls} cells={cells} />
      })}
    </div>
  )
}
