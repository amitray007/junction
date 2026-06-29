// SPDX-License-Identifier: AGPL-3.0-only
// Card primitive — bg-100, alpha-400 border, shadow-sm, 12px radius.
// Header row (h3 + meta) + body. Never nested (DESIGN.md anti-slop rule).

import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "bg-[var(--bg-100)] border border-[var(--alpha-400)] rounded-[var(--radius-12)]",
        "p-[var(--card-padding)]",
        className,
      )}
      style={{ boxShadow: "var(--shadow-sm)" }}
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
      className={cn("leading-none", className)}
      style={{
        fontSize: "var(--text-h3)",
        fontWeight: 600,
        color: "var(--gray-1000)",
      }}
      {...props}
    />
  )
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("", className)} {...props} />
}
