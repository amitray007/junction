// SPDX-License-Identifier: AGPL-3.0-only
// Kbd — keyboard shortcut hint chip.

import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center",
        "h-5 min-w-5 px-1",
        "rounded-[var(--radius-sm)] border border-[var(--border)]",
        "bg-[var(--surface-2)]",
        "font-mono text-[var(--text-eyebrow)] text-[var(--muted)] leading-none",
        "select-none",
        className,
      )}
      {...props}
    />
  )
}
