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
        "rounded-[var(--radius-6)] border border-[var(--alpha-400)]",
        "select-none",
        className,
      )}
      style={{
        backgroundColor: "var(--gray-100)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-caption)",
        color: "var(--gray-700)",
        lineHeight: 1,
      }}
      {...props}
    />
  )
}
