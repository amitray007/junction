// SPDX-License-Identifier: AGPL-3.0-only
// Code — shared inline mono primitives (rule-of-three DRY, inc 24.5).
//
// MonoChip: blue-text-on-blue-bg rounded pill for namespace chips, kind tags,
//           key→profile labels. Use wherever a highlighted mono token appears.
//
// MonoCode: plain inline mono `<code>` for CLI hints, IDs, account labels.
//           Neutral gray-900 — no background, no border.

import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

// ─── MonoChip ─────────────────────────────────────────────────────────────────
// Blue chip: --blue-text on --blue-bg, --radius-6, --font-mono, --text-mono.
// Renders as <span> (inline, wraps in prose or flex rows).

export interface MonoChipProps extends HTMLAttributes<HTMLSpanElement> {
  readonly children: React.ReactNode
}

export function MonoChip({ children, className, style, ...props }: MonoChipProps) {
  return (
    <span
      className={cn("inline-flex items-center", className)}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-mono)",
        color: "var(--blue-text)",
        backgroundColor: "var(--blue-bg)",
        borderRadius: "var(--radius-6)",
        padding: "1px 6px",
        lineHeight: 1.5,
        ...style,
      }}
      {...props}
    >
      {children}
    </span>
  )
}

// ─── MonoCode ─────────────────────────────────────────────────────────────────
// Inline mono `<code>` for CLI commands, IDs, path fragments, account labels.
// No background — blends into surrounding text. Use inside <p> or description copy.

export interface MonoCodeProps extends HTMLAttributes<HTMLElement> {
  readonly children: React.ReactNode
}

export function MonoCode({ children, className, style, ...props }: MonoCodeProps) {
  return (
    <code
      className={className}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-mono)",
        color: "var(--gray-900)",
        ...style,
      }}
      {...props}
    >
      {children}
    </code>
  )
}
