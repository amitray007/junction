// SPDX-License-Identifier: AGPL-3.0-only
// Textarea — multi-line text input, token-driven (mirrors Input exactly).
// React 19: ref is a plain prop — no forwardRef wrapper.

import type { Ref, TextareaHTMLAttributes } from "react"
import { cn } from "./cn.js"

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Shows a red error ring and aria-invalid when true. */
  readonly hasError?: boolean
  /** React 19: ref is a plain prop, not forwardRef. */
  ref?: Ref<HTMLTextAreaElement>
}

export function Textarea({ className, hasError, ref, ...props }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      aria-invalid={hasError === true ? true : undefined}
      className={cn(
        "flex w-full",
        "px-[var(--cell-padding-x)] py-2",
        "rounded-[var(--radius-6)] border",
        "text-[var(--text-body)] font-mono",
        "transition-colors duration-[var(--motion-fast)]",
        "placeholder:text-[var(--gray-600)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        hasError
          ? "border-[var(--status-error-fg)] ring-1 ring-[var(--status-error-fg)]/30"
          : "border-[var(--alpha-400)]",
        className,
      )}
      style={{
        backgroundColor: "var(--bg-100)",
        color: "var(--gray-1000)",
        minHeight: "96px",
      }}
      {...props}
    />
  )
}
