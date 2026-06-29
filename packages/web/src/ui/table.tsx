// SPDX-License-Identifier: AGPL-3.0-only
// Table — data table. ~44px rows, 14px body, mono for identifiers.
// Column headers: gray-700 12px text, NOT uppercase-mono (DESIGN.md §Components).
// Hover: gray-100. Hairline alpha-200 row dividers.
// Actions column: ⋯ trigger revealed on hover/focus, keyboard-reachable.

import { MoreHorizontal } from "lucide-react"
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react"
import { cn } from "./cn.js"

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div
      className="w-full overflow-auto rounded-[var(--radius-12)] border border-[var(--alpha-400)]"
      style={{ boxShadow: "var(--shadow-sm)" }}
    >
      <table
        className={cn("w-full border-collapse", className)}
        style={{ fontSize: "var(--text-body)" }}
        {...props}
      />
    </div>
  )
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        "sticky top-0 z-10 relative",
        "after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-[var(--alpha-200)]",
        className,
      )}
      style={{ backgroundColor: "var(--bg-100)" }}
      {...props}
    />
  )
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn("", className)} style={{ backgroundColor: "var(--bg-100)" }} {...props} />
  )
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-[var(--alpha-200)] last:border-0",
        "transition-colors duration-[var(--motion-fast)]",
        "hover:bg-[var(--gray-100)]",
        // Reveal the actions cell trigger on row hover/focus-within.
        "group",
        className,
      )}
      style={{ height: "var(--row-height-data)" }}
      {...props}
    />
  )
}

export type SortDirection = "ascending" | "descending" | "none"

export interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** When provided, renders an aria-sort attribute for sortable columns. */
  readonly sortDirection?: SortDirection
}

export function TableHead({ className, sortDirection, ...props }: TableHeadProps) {
  return (
    <th
      aria-sort={sortDirection}
      className={cn(
        "px-[var(--cell-padding-x)] py-[var(--cell-padding-y)]",
        "text-left align-middle",
        "font-medium",
        "whitespace-nowrap",
        sortDirection &&
          sortDirection !== "none" &&
          "cursor-pointer select-none hover:text-[var(--gray-1000)]",
        className,
      )}
      style={{
        // 12px column headers, gray-700 — NOT uppercase-mono (DESIGN.md §Components)
        fontSize: "var(--text-caption)",
        color: "var(--gray-700)",
        height: "var(--row-height-header)",
      }}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn(
        "px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] align-middle",
        className,
      )}
      style={{ color: "var(--gray-1000)" }}
      {...props}
    />
  )
}

// ─── Actions column ────────────────────────────────────────────────────────────
// ⋯ button: visually hidden until row hover/focus, always keyboard-reachable.

import { DropdownMenu, DropdownMenuTrigger } from "./dropdown-menu.js"

export function TableActionsHead({ className }: { readonly className?: string }) {
  return <TableHead className={cn("w-12 text-right", className)} aria-label="Row actions" />
}

const triggerButtonClassName = cn(
  "inline-flex items-center justify-center",
  "h-7 w-7 rounded-[var(--radius-6)]",
  "transition-colors duration-[var(--motion-fast)]",
  "hover:bg-[var(--gray-100)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
  // Visually hidden until row hover/focus; always keyboard-reachable.
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
)

export function TableActionsCell({
  className,
  menu,
}: {
  readonly className?: string
  readonly menu?: React.ReactNode
}) {
  return (
    <TableCell className={cn("w-12 text-right pr-2", className)}>
      {menu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Row actions"
              aria-haspopup="menu"
              className={triggerButtonClassName}
              style={{ color: "var(--gray-700)", backgroundColor: "transparent" }}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          {menu}
        </DropdownMenu>
      ) : (
        <button
          type="button"
          aria-label="Row actions"
          aria-haspopup="menu"
          className={triggerButtonClassName}
          style={{ color: "var(--gray-700)", backgroundColor: "transparent" }}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </TableCell>
  )
}
