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
// B4: full-width row used for platform group headings in the credentials table (Phase 4).
// Shows a platform label + optional kind chip + count as a quiet section break.

interface TableGroupRowProps {
  /** Number of columns the row should span. */
  readonly colSpan: number
  /** Primary label (e.g. platform display name). */
  readonly label: string
  /** Optional kind chip text (e.g. "openapi"). */
  readonly kind?: string
  /** Optional count shown after the label. */
  readonly count?: number
  readonly className?: string
}

export function TableGroupRow({ colSpan, label, kind, count, className }: TableGroupRowProps) {
  return (
    <tr
      className={cn("border-b border-[var(--alpha-200)]", className)}
      style={{ backgroundColor: "var(--bg-200)" }}
      aria-label={`Group: ${label}`}
    >
      <td
        colSpan={colSpan}
        className="px-[var(--cell-padding-x)] py-1.5"
        style={{ color: "var(--gray-700)" }}
      >
        <div className="flex items-center gap-2">
          <span
            style={{
              fontSize: "var(--text-caption)",
              fontWeight: 500,
              color: "var(--gray-700)",
            }}
          >
            {label}
          </span>
          {kind && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-caption)",
                color: "var(--gray-700)",
                backgroundColor: "var(--alpha-200)",
                borderRadius: "var(--radius-6)",
                padding: "0 6px",
              }}
            >
              {kind}
            </span>
          )}
          {count !== undefined && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-caption)",
                color: "var(--gray-700)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {count}
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
// ⋯ button: ALWAYS visible (low opacity at rest, full on hover/focus-within).
// E11a fix: the previous opacity-0-until-hover pattern made the trigger invisible
// and unreachable by real pointer events (trackpad/touch had nothing to hit). A
// persistently visible trigger (opacity-40 at rest → opacity-100 on hover/focus)
// is the correct pattern for a primary row action. Keyboard remains fully supported
// via focus-visible ring.

export function TableActionsHead({ className }: { readonly className?: string }) {
  return <TableHead className={cn("w-12 text-right", className)} aria-label="Row actions" />
}

const triggerButtonClassName = cn(
  "inline-flex items-center justify-center",
  "h-7 w-7 rounded-[var(--radius-6)]",
  "transition-colors duration-[var(--motion-fast)]",
  "hover:bg-[var(--gray-100)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
  // Always visible: low-opacity at rest, full opacity on row hover/focus-within (E11a).
  // Was: opacity-0 group-hover:opacity-100 — made it impossible to click with pointer.
  "opacity-40 group-hover:opacity-100 group-focus-within:opacity-100",
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
