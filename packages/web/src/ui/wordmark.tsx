// SPDX-License-Identifier: AGPL-3.0-only
// <Wordmark /> — the ONLY component that uses Departure Mono.
// "JUNCTION" + amber square node (the patch-point glyph).
// Discipline rule: Departure Mono is display-only. Never use it elsewhere.

import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

type WordmarkProps = HTMLAttributes<HTMLSpanElement>

export function Wordmark({ className, ...props }: WordmarkProps) {
  return (
    <span
      role="img"
      className={cn("inline-flex items-center gap-1.5 select-none", className)}
      aria-label="Junction"
      {...props}
    >
      {/* The one Departure Mono usage in the entire app */}
      <span
        style={{ fontFamily: "var(--font-display)", fontSize: "15px", letterSpacing: "0.04em" }}
        aria-hidden="true"
      >
        JUNCTION
      </span>
      {/* Amber square node — the patch-point glyph. Deliberately radius-0 (the one sharp element). */}
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "6px",
          height: "6px",
          borderRadius: "0",
          backgroundColor: "var(--accent-fill)",
          flexShrink: 0,
        }}
      />
    </span>
  )
}
