// SPDX-License-Identifier: AGPL-3.0-only
// Field — label + control + inline error/description, a11y-wired.
// Associates a label with its control via htmlFor; injects aria-describedby
// onto the direct child control so screen readers announce the error/description
// when the control receives focus.

import { Children, cloneElement, isValidElement, type ReactNode } from "react"
import { cn } from "./cn.js"

export interface FieldProps {
  /** The form control's id — wires htmlFor + aria-describedby. */
  readonly id: string
  /** Label text. */
  readonly label: string
  /** Inline error message — shown below the control with role=alert. */
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
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined

  // Inject aria-describedby and aria-invalid onto the direct child control so
  // screen readers announce the error/description when the input is focused.
  // cloneElement is safe here because Field's contract is "one control child"
  // and all our primitives accept standard HTMLElement props.
  const control = (() => {
    const child = Children.only(children)
    if (!isValidElement(child)) return child
    type ControlProps = { "aria-describedby"?: string; "aria-invalid"?: true }
    const extraProps: ControlProps = {}
    if (describedBy) extraProps["aria-describedby"] = describedBy
    if (error) extraProps["aria-invalid"] = true
    if (Object.keys(extraProps).length === 0) return child
    return cloneElement(child as React.ReactElement<ControlProps>, extraProps)
  })()

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={id}
        style={{
          fontSize: "var(--text-label)",
          fontWeight: 500,
          color: "var(--gray-1000)",
          lineHeight: 1.25,
        }}
      >
        {label}
      </label>

      {control}

      {description && (
        <p
          id={descriptionId}
          style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}
        >
          {description}
        </p>
      )}

      {error && (
        <p
          id={errorId}
          role="alert"
          style={{ fontSize: "var(--text-caption)", color: "var(--status-error-fg)", margin: 0 }}
        >
          {error}
        </p>
      )}
    </div>
  )
}
