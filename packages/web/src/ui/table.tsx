// SPDX-License-Identifier: AGPL-3.0-only
// Table — data table. ~44px rows, 14px body, mono for identifiers.
// Column headers: gray-700 12px text, NOT uppercase-mono (DESIGN.md §Components).
// Hover: gray-100. Hairline alpha-200 row dividers.
// Actions column: ⋯ trigger revealed on hover/focus, keyboard-reachable.
// B4 extensions: group-divider row, pagination footer, sortable header affordance,
//               mono cell helper — for Phase 4/5 credential/profile tables.

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  MoreHorizontal,
} from "lucide-react"
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react"
import { cn } from "./cn.js"
import { DropdownMenu, DropdownMenuTrigger } from "./dropdown-menu.js"

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
      style={{ backgroundColor: "var(--bg-200)" }}
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
  /** Called when the user clicks/keyboards this sortable header. */
  readonly onSort?: () => void
}

export function TableHead({
  className,
  sortDirection,
  onSort,
  children,
  ...props
}: TableHeadProps) {
  const isSortable = onSort !== undefined

  // Sortable header: render as a button for full keyboard/click reachability (B4).
  if (isSortable) {
    return (
      <th
        aria-sort={sortDirection ?? "none"}
        className={cn(
          "px-[var(--cell-padding-x)] py-0",
          "text-left align-middle",
          "font-medium",
          "whitespace-nowrap",
          className,
        )}
        style={{
          fontSize: "var(--text-caption)",
          color: "var(--gray-700)",
          height: "var(--row-height-header)",
        }}
        {...props}
      >
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "inline-flex items-center gap-1",
            "h-full w-full",
            "transition-colors duration-[var(--motion-fast)]",
            "hover:text-[var(--gray-1000)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1 focus-visible:rounded-[var(--radius-6)]",
            "cursor-pointer select-none",
          )}
          style={{
            color: "inherit",
            background: "none",
            border: "none",
            font: "inherit",
            padding: 0,
          }}
        >
          {children}
          {/* Sort indicator — visible asc/desc chevron */}
          <span
            aria-hidden="true"
            style={{ flexShrink: 0, opacity: sortDirection === "none" ? 0.4 : 1 }}
          >
            {sortDirection === "ascending" ? "↑" : sortDirection === "descending" ? "↓" : "↕"}
          </span>
        </button>
      </th>
    )
  }

  return (
    <th
      aria-sort={sortDirection}
      className={cn(
        "px-[var(--cell-padding-x)] py-[var(--cell-padding-y)]",
        "text-left align-middle",
        "font-medium",
        "whitespace-nowrap",
        className,
      )}
      style={{
        // 12px column headers, gray-700 — NOT uppercase-mono (DESIGN.md §Components)
        fontSize: "var(--text-caption)",
        color: "var(--gray-700)",
        height: "var(--row-height-header)",
      }}
      {...props}
    >
      {children}
    </th>
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

// TableCellMono — cell with mono/tabular styling for IDs, namespaces, counts.
// Use instead of TableCell for identifier / numeric data (B4).
export function TableCellMono({
  className,
  style,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <TableCell
      className={cn("font-mono", className)}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-mono)",
        fontVariantNumeric: "tabular-nums",
        color: "var(--gray-900)",
        ...style,
      }}
      {...props}
    />
  )
}

// ─── Group divider row ─────────────────────────────────────────────────────────
// B4/inc-25: Variant-C mockup group divider — uppercase mono platform name +
// kind badge + stretching divider line + "N {unit}" count on the right.
// Row height 32px, bg color-mix(gray-100 60%, transparent).

interface TableGroupRowProps {
  /** Number of columns the row should span. */
  readonly colSpan: number
  /** Primary label (e.g. platform display name) — rendered uppercase mono. */
  readonly label: string
  /** Optional kind chip text (e.g. "openapi") — NOT uppercased. */
  readonly kind?: string
  /** Optional count shown on the right. */
  readonly count?: number
  /** Unit word appended to the count (e.g. "credentials"). Default: "items". */
  readonly unit?: string
  readonly className?: string
}

export function TableGroupRow({
  colSpan,
  label,
  kind,
  count,
  unit = "items",
  className,
}: TableGroupRowProps) {
  return (
    <tr
      className={cn("border-b border-[var(--alpha-200)]", className)}
      style={{
        height: "32px",
        backgroundColor: "color-mix(in srgb, var(--gray-100) 60%, transparent)",
      }}
      aria-label={`Group: ${label}`}
    >
      <td colSpan={colSpan} style={{ padding: "0 16px", verticalAlign: "middle" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* Platform name — uppercase, 11px, mono, gray-700, letter-spacing */}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              color: "var(--gray-700)",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
          {/* Kind badge — 10px, NOT uppercase, gray-600 on alpha-200 bg, alpha-400 border */}
          {kind && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 500,
                color: "var(--gray-600)",
                backgroundColor: "var(--alpha-200)",
                border: "1px solid var(--alpha-400)",
                borderRadius: "var(--radius-6)",
                padding: "1px 5px",
                whiteSpace: "nowrap",
              }}
            >
              {kind}
            </span>
          )}
          {/* Stretching divider line */}
          <span
            style={{
              flex: 1,
              height: "1px",
              backgroundColor: "var(--alpha-200)",
              marginLeft: "4px",
            }}
            aria-hidden="true"
          />
          {/* Count on the right: "N credentials" */}
          {count !== undefined && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                fontWeight: 400,
                color: "var(--gray-600)",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {count} {unit}
            </span>
          )}
        </div>
      </td>
    </tr>
  )
}

// ─── Pagination footer ─────────────────────────────────────────────────────────
// B4: pure presentational — takes page/pageCount/total/onPageChange.
// Used by Phase 4 credentials table (and any future paginated table).

interface TablePaginationProps {
  readonly page: number
  readonly pageCount: number
  readonly total: number
  readonly onPageChange: (page: number) => void
  readonly className?: string
}

export function TablePagination({
  page,
  pageCount,
  total,
  onPageChange,
  className,
}: TablePaginationProps) {
  const isFirst = page <= 1
  const isLast = page >= pageCount

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2",
        "px-[var(--cell-padding-x)] py-2",
        "border-t border-[var(--alpha-200)]",
        className,
      )}
      style={{ backgroundColor: "var(--bg-100)" }}
    >
      <span
        style={{
          fontSize: "var(--text-caption)",
          color: "var(--gray-700)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {total} total
      </span>

      <nav className="flex items-center gap-1" aria-label="Page navigation">
        {/* First page */}
        <PaginationBtn onClick={() => onPageChange(1)} disabled={isFirst} aria-label="First page">
          <ChevronsLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </PaginationBtn>
        {/* Previous page */}
        <PaginationBtn
          onClick={() => onPageChange(page - 1)}
          disabled={isFirst}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </PaginationBtn>

        {/* Page indicator */}
        <span
          style={{
            fontSize: "var(--text-caption)",
            color: "var(--gray-700)",
            padding: "0 4px",
            fontVariantNumeric: "tabular-nums",
            minWidth: "3rem",
            textAlign: "center",
          }}
        >
          {page} / {pageCount}
        </span>

        {/* Next page */}
        <PaginationBtn
          onClick={() => onPageChange(page + 1)}
          disabled={isLast}
          aria-label="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </PaginationBtn>
        {/* Last page */}
        <PaginationBtn
          onClick={() => onPageChange(pageCount)}
          disabled={isLast}
          aria-label="Last page"
        >
          <ChevronsRight className="h-3.5 w-3.5" aria-hidden="true" />
        </PaginationBtn>
      </nav>
    </div>
  )
}

function PaginationBtn({
  children,
  disabled,
  onClick,
  "aria-label": ariaLabel,
}: {
  readonly children: React.ReactNode
  readonly disabled: boolean
  readonly onClick: () => void
  readonly "aria-label": string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center justify-center",
        "h-6 w-6 rounded-[var(--radius-6)]",
        "transition-colors duration-[var(--motion-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
        disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-[var(--gray-100)] cursor-pointer",
      )}
      style={{ color: "var(--gray-700)", backgroundColor: "transparent", border: "none" }}
    >
      {children}
    </button>
  )
}

// ─── Empty table row ──────────────────────────────────────────────────────────
// B3: full-width row for empty table state. Shows a message + first action.
// Use inside <TableBody> when there are no data rows.

interface EmptyTableRowProps {
  readonly colSpan: number
  readonly message: string
  readonly action?: React.ReactNode
  readonly className?: string
}

export function EmptyTableRow({ colSpan, message, action, className }: EmptyTableRowProps) {
  return (
    <tr className={cn(className)}>
      <td
        colSpan={colSpan}
        className="px-[var(--cell-padding-x)]"
        style={{ color: "var(--gray-700)", textAlign: "center" }}
      >
        <div
          className="flex items-center justify-center gap-3 py-8"
          style={{ fontSize: "var(--text-body)" }}
        >
          <span>{message}</span>
          {action}
        </div>
      </td>
    </tr>
  )
}

// ─── Actions column ────────────────────────────────────────────────────────────
// ⋯ button: opens on HOVER (small close delay so moving to menu doesn't dismiss it)
// as well as click + keyboard (Enter/Space opens, Esc closes, arrows navigate).
// Always visible at low opacity; full opacity on row hover/focus-within (E11a).
// Focus after action: Radix's onCloseAutoFocus returns focus to the trigger button.

export function TableActionsHead({ className }: { readonly className?: string }) {
  return <TableHead className={cn("w-12 text-right", className)} aria-label="Row actions" />
}

const triggerButtonClassName = cn(
  "inline-flex items-center justify-center",
  "h-7 w-7 rounded-[var(--radius-6)]",
  // Transition BOTH colors + opacity so the hover reveal fades in (was snapping 40→100%).
  "transition-[color,background-color,opacity] duration-[var(--motion-fast)]",
  "hover:bg-[var(--gray-100)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
  // Always visible: low-opacity at rest, full opacity on row hover/focus-within (E11a).
  "opacity-40 group-hover:opacity-100 group-focus-within:opacity-100",
)

export function TableActionsCell({
  className,
  menu,
}: {
  readonly className?: string
  /** DropdownMenuContent (or similar) to render inside a DropdownMenu. Required — callers
   * that have no actions should omit the column entirely (don't render TableActionsCell). */
  readonly menu: React.ReactNode
}) {
  // Click-to-open (Radix default, uncontrolled). A previous hover-to-open implementation
  // flickered: Radix portals the menu with a gap (sideOffset) from the trigger, so the
  // pointer crossing that gap fired mouseleave→close while the open state + zoom animation
  // re-triggered — a visible open/close loop. Click is the robust, flicker-free standard;
  // the trigger stays keyboard-reachable (Enter/Space) and always-visible.
  return (
    <TableCell className={cn("w-12 text-right pr-2", className)}>
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
    </TableCell>
  )
}
