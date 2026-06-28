// SPDX-License-Identifier: AGPL-3.0-only
// Skeleton — loading placeholder with pulse animation (reduced-motion: static).

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
