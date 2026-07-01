// SPDX-License-Identifier: AGPL-3.0-only
// Input — single-line text input, 32px control height, token-driven.
// React 19: ref is a plain prop — no forwardRef wrapper.
// Keeps aria-invalid / aria-describedby wiring (injected by Field).

import type { InputHTMLAttributes, Ref } from "react"
import { cn } from "./cn.js"

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Shows a red error ring and aria-invalid when true. */
  readonly hasError?: boolean
  /** React 19: ref is a plain prop, not forwardRef. */
  ref?: Ref<HTMLInputElement>
}

export function Input({ className, hasError, ref, ...props }: InputProps) {
  return (
    <input
      ref={ref}
      aria-invalid={hasError === true ? true : undefined}
      className={cn(
        "flex w-full",
        "h-[var(--control-height)] px-[var(--cell-padding-x)]",
        "rounded-[var(--radius-6)] border",
        "text-[var(--text-body)] font-sans",
        // Smooth border + shadow (the focus glow) transition in/out.
        "transition-[color,border-color,box-shadow] duration-[var(--motion-fast)]",
        "placeholder:text-[var(--gray-600)]",
        // Subtle focus: accent border + a soft low-alpha ring (no harsh 2px offset).
        "outline-none",
        hasError
          ? "border-[var(--status-error-fg)] focus-visible:shadow-[0_0_0_3px_var(--focus-ring-error)]"
          : "border-[var(--alpha-400)] hover:border-[var(--gray-600)] focus-visible:border-[var(--focus-border)] focus-visible:shadow-[0_0_0_3px_var(--focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      style={{
        backgroundColor: "var(--bg-100)",
        color: "var(--gray-1000)",
      }}
      {...props}
    />
  )
}
