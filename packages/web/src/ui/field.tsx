// SPDX-License-Identifier: AGPL-3.0-only
// Field — label + control + inline error/description, a11y-wired.
// Associates a label with its control via htmlFor; exposes error and description
// via aria-describedby on the control. Built inc 23; wired to writes inc 24+.

import type { ReactNode } from "react"
import { cn } from "./cn.js"

export interface FieldProps {
  /** The form control's id — wires htmlFor + aria-describedby. */
  readonly id: string
  /** Label text. */
  readonly label: string
  /** Inline error message — also sets aria-invalid on the control if non-empty. */
  readonly error?: string
  /** Optional description shown below the control. */
  readonly description?: string
  /** The control to render (Input, Select, Switch, etc.). */
  readonly children: ReactNode
  readonly className?: string
}

export function Field({ id, label, error, description, children, className }: FieldProps) {
  const descriptionId = description ? `${id}-description` : undefined
  const errorId = error ? `${id}-error` : undefined

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {/* Label */}
      <label
        htmlFor={id}
        style={{
          fontSize: "var(--text-body)",
          fontWeight: 500,
          color: "var(--fg)",
          lineHeight: 1.25,
        }}
      >
        {label}
      </label>

      {/* Control — rendered with aria-describedby pointing at error/description */}
      <div aria-describedby={[descriptionId, errorId].filter(Boolean).join(" ") || undefined}>
        {children}
      </div>

      {/* Description */}
      {description && (
        <p
          id={descriptionId}
          style={{
            fontSize: "var(--text-eyebrow)",
            color: "var(--muted)",
            margin: 0,
          }}
        >
          {description}
        </p>
      )}

      {/* Inline error */}
      {error && (
        <p
          id={errorId}
          role="alert"
          style={{
            fontSize: "var(--text-eyebrow)",
            color: "var(--status-error-fg)",
            margin: 0,
          }}
        >
          {error}
        </p>
      )}
    </div>
  )
}
