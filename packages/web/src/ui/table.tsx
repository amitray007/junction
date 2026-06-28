// SPDX-License-Identifier: AGPL-3.0-only
// Table — instrument-grade data table. 36px rows / 40px header, 8x12 cell padding.
// Geist Mono for ID/namespace columns. Compact density.
// Phase E additions: sticky thead, aria-sort hooks, trailing actions-column scaffold.
// Actions column: ⋯ trigger revealed on hover/focus, keyboard-reachable (inc 23 scaffold;
// real row actions wired to data in inc 24+).

import { MoreHorizontal } from "lucide-react"
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react"
import { cn } from "./cn.js"

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-auto rounded-[var(--radius-md)] border border-[var(--border)]">
      <table
        className={cn("w-full border-collapse text-[var(--text-body)]", className)}
        {...props}
      />
    </div>
  )
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        // Sticky header: stays visible while the table body scrolls.
        // --surface bg ensures content behind doesn't bleed through.
        "sticky top-0 z-10",
        "bg-[var(--surface)]",
        // Bottom border to separate header from body on scroll.
        "after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-[var(--border)]",
        "relative",
        className,
      )}
      {...props}
    />
  )
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("bg-[var(--bg)]", className)} {...props} />
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "h-[var(--row-height-data)] border-b border-[var(--border)]",
        "transition-colors duration-[var(--motion-micro)]",
        "hover:bg-[var(--surface)] last:border-0",
        // Reveal the actions cell trigger on row hover/focus-within.
        "group",
        className,
      )}
      {...props}
    />
  )
}

export type SortDirection = "ascending" | "descending" | "none"

export interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** When provided, renders an aria-sort attribute for sortable columns.
   *  Actual sort handler wired in inc 24+; scaffold lands here for a11y. */
  readonly sortDirection?: SortDirection
}

export function TableHead({ className, sortDirection, ...props }: TableHeadProps) {
  return (
    <th
      aria-sort={sortDirection}
      className={cn(
        "h-[var(--row-height-header)]",
        "px-[var(--cell-padding-x)] py-[var(--cell-padding-y)]",
        "text-left align-middle",
        "text-[var(--text-eyebrow)] font-medium uppercase tracking-[var(--tracking-eyebrow)]",
        "text-[var(--muted)]",
        "whitespace-nowrap",
        sortDirection &&
          sortDirection !== "none" &&
          "cursor-pointer select-none hover:text-[var(--fg)]",
        className,
      )}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn(
        "px-[var(--cell-padding-x)] py-[var(--cell-padding-y)]",
        "align-middle",
        "text-[var(--fg)]",
        className,
      )}
      {...props}
    />
  )
}

// TableCaption removed — genuinely dead, no consumer. Re-add if tables need accessible captions.

// ─── Actions column scaffold ──────────────────────────────────────────────────
// Renders a ⋯ button in the trailing column. The button is visually hidden
// until the row is hovered or the cell receives focus — but always keyboard-
// reachable (opacity-0 does not remove from tab order; we use opacity + pointer-
// events, not display:none or visibility:hidden).
//
// The DropdownMenuTrigger is wired here as the structural scaffold; actual menu
// items are added in inc 24+ when row actions exist.

export function TableActionsHead({ className }: { readonly className?: string }) {
  return <TableHead className={cn("w-12 text-right", className)} aria-label="Row actions" />
}

export function TableActionsCell({
  className,
  children,
}: {
  readonly className?: string
  /** DropdownMenuContent to render when the trigger is activated. */
  readonly children?: React.ReactNode
}) {
  return (
    <TableCell className={cn("w-12 text-right pr-2", className)}>
      {/* Scaffold: plain button for the row-actions trigger.
          In inc 24+ this becomes a DropdownMenu with real menu items.
          aria-label provides the accessible name. */}
      <button
        type="button"
        aria-label="Row actions"
        aria-haspopup="menu"
        className={cn(
          "inline-flex items-center justify-center",
          "h-7 w-7 rounded-[var(--radius-sm)]",
          "transition-[opacity,colors] duration-[var(--motion-micro)]",
          "hover:bg-[var(--surface-2)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
          // Visually hidden until row hover/focus; always keyboard-reachable.
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
        style={{ color: "var(--muted)", backgroundColor: "transparent" }}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {children}
    </TableCell>
  )
}
