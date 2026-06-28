// SPDX-License-Identifier: AGPL-3.0-only
// Card primitive — surface container with 1px border, no drop shadow.
// Separation is borders, not shadows (DESIGN.md anti-slop rule).

import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-md)]",
        "p-[var(--card-padding)]",
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-3", className)} {...props} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        "text-[var(--text-section)] font-semibold text-[var(--fg)] leading-none",
        className,
      )}
      {...props}
    />
  )
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("", className)} {...props} />
}

// CardFooter removed — genuinely dead, no inc-24 consumer planned.
// Add back (with a comment) if a card action-footer pattern emerges.
