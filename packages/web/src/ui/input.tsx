// SPDX-License-Identifier: AGPL-3.0-only
// Input — single-line text input, 32px control height, token-driven.
// Built and tested in inc 23; NOT wired to write paths (inc 24+).

import { forwardRef, type InputHTMLAttributes } from "react"
import { cn } from "./cn.js"

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Shows a red error ring and aria-invalid when true. */
  readonly hasError?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, hasError, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={hasError === true ? true : undefined}
      className={cn(
        "flex w-full",
        "h-[var(--control-height)]",
        "px-[var(--cell-padding-x)]",
        "rounded-[var(--radius-sm)] border",
        "text-[var(--text-body)] font-sans",
        "transition-colors duration-[var(--motion-micro)]",
        "placeholder:text-[var(--muted)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        hasError
          ? "border-[var(--status-error-fg)] ring-1 ring-[var(--status-error-fg)]/30"
          : "border-[var(--border)]",
        className,
      )}
      style={{
        backgroundColor: "var(--bg)",
        color: "var(--fg)",
      }}
      {...props}
    />
  )
})
