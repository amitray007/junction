// SPDX-License-Identifier: AGPL-3.0-only
// Table — instrument-grade data table. 36px rows / 40px header, 8x12 cell padding.
// Geist Mono for ID/namespace columns. Compact density.

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
  return <thead className={cn("bg-[var(--surface)]", className)} {...props} />
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
        className,
      )}
      {...props}
    />
  )
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "h-[var(--row-height-header)]",
        "px-[var(--cell-padding-x)] py-[var(--cell-padding-y)]",
        "text-left align-middle",
        "text-[var(--text-eyebrow)] font-medium uppercase tracking-[var(--tracking-eyebrow)]",
        "text-[var(--muted)]",
        "whitespace-nowrap",
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

export function TableCaption({ className, ...props }: HTMLAttributes<HTMLTableCaptionElement>) {
  return (
    <caption
      className={cn("mt-4 text-[var(--text-body)] text-[var(--muted)]", className)}
      {...props}
    />
  )
}
