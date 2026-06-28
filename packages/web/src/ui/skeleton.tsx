// SPDX-License-Identifier: AGPL-3.0-only
// Skeleton — loading placeholder with pulse animation (reduced-motion: static).
// Phase E additions: TableSkeleton renders N rows at exactly --row-height-data
// with matching column widths to prevent reflow when data loads.

import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-[var(--radius-sm)] bg-[var(--surface-2)]",
        // Pulse gated on prefers-reduced-motion
        "motion-safe:animate-pulse",
        className,
      )}
      {...props}
    />
  )
}

// Convenience: a row of skeleton content for table loading states.
// tr is not a focusable element so aria-hidden is safe here.
export function SkeletonRow({ cols = 4 }: { readonly cols?: number }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: <tr> is not focusable; aria-hidden is safe
    <tr aria-hidden="true">
      {Array.from({ length: cols }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: index is stable for static loading rows
        <td key={i} className="px-[var(--cell-padding-x)] py-[var(--cell-padding-y)]">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  )
}

// Column width descriptor for TableSkeleton — mirrors the real table layout so
// the skeleton occupies the exact loaded-content box (zero vertical reflow).
export interface SkeletonColumn {
  /** Tailwind width class or CSS value, e.g. "w-32" or "20%". */
  readonly width?: string
  /** Fill remaining space. */
  readonly flex?: boolean
}

// Internal helper: a single skeleton data row. Extracted so the caller can pass
// `key=` at the call site (on a single line the biome-ignore comment can cover).
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
      style={{ height: "var(--row-height-data)", backgroundColor: "var(--bg)" }}
    >
      {cells}
    </div>
  )
}

// TableSkeleton renders N rows at exactly --row-height-data height with column
// widths that mirror the real table, preventing both horizontal and vertical
// reflow when data arrives. Wire as the route pendingComponent or loading branch.
export function TableSkeleton({
  rows = 5,
  columns,
  className,
}: {
  readonly rows?: number
  /** Column descriptors — length should match the real table's column count. */
  readonly columns?: SkeletonColumn[]
  readonly className?: string
}) {
  const cols = columns ?? [{ flex: true }, { width: "w-24" }, { width: "w-20" }, { width: "w-16" }]

  return (
    <div
      role="status"
      aria-label="Loading…"
      className={cn(
        "w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]",
        className,
      )}
    >
      {/* Fake header row at --row-height-header */}
      <div
        aria-hidden="true"
        className="flex items-center gap-3 border-b border-[var(--border)] px-[var(--cell-padding-x)]"
        style={{
          height: "var(--row-height-header)",
          backgroundColor: "var(--surface)",
        }}
      >
        {cols.map((col, i) => {
          const hdrCls = cn("h-3", col.flex ? "flex-1" : (col.width ?? "w-20"))
          // biome-ignore lint/suspicious/noArrayIndexKey: stable static skeleton columns — order never changes
          return <Skeleton key={i} className={hdrCls} style={{ opacity: 0.5 }} />
        })}
      </div>

      {/* Data rows at --row-height-data — index keys are intentional: static skeleton never reorders */}
      {Array.from({ length: rows }, (_, rowIdx) => {
        const rowCls = cn(
          "flex items-center gap-3 border-b border-[var(--border)] px-[var(--cell-padding-x)]",
          "last:border-0",
        )
        const cells = cols.map((col, colIdx) => {
          const cls = cn("h-4", col.flex ? "flex-1" : (col.width ?? "w-20"))
          // biome-ignore lint/suspicious/noArrayIndexKey: stable static skeleton columns — order never changes
          return <Skeleton key={colIdx} className={cls} />
        })
        // Stable index key: skeleton rows are static placeholders, never reordered.
        // biome-ignore lint/suspicious/noArrayIndexKey: stable static skeleton rows — count is fixed, never reorders
        return <SkeletonDataRow key={rowIdx} className={rowCls} cells={cells} />
      })}
    </div>
  )
}
