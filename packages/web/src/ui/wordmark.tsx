// SPDX-License-Identifier: AGPL-3.0-only
// Wordmark — J glyph + "Junction" lockup (Geist Sans).
// Replaces the inc-23 Departure Mono "JUNCTION" + amber square (retired inc 24.5).
// The J glyph is a small rounded-square mark in gray-1000; text is Geist Sans.

import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

/**
 * The "J" mark — a small rounded-square glyph in gray-1000. Shared by the full
 * Wordmark and the sidebar's collapsed (icon-only) state, so the two never drift.
 */
export function JGlyph() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "20px",
        height: "20px",
        borderRadius: "var(--radius-6)",
        backgroundColor: "var(--gray-1000)",
        color: "var(--bg-100)",
        fontFamily: "var(--font-sans)",
        fontSize: "12px",
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      J
    </span>
  )
}

type WordmarkProps = HTMLAttributes<HTMLSpanElement>

export function Wordmark({ className, ...props }: WordmarkProps) {
  return (
    <span
      role="img"
      className={cn("inline-flex items-center gap-2 select-none", className)}
      aria-label="Junction"
      {...props}
    >
      <JGlyph />
      {/* Logotype */}
      <span
        aria-hidden="true"
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "15px",
          fontWeight: 600,
          color: "var(--gray-1000)",
          letterSpacing: "-0.01em",
          lineHeight: 1,
        }}
      >
        Junction
      </span>
    </span>
  )
}
