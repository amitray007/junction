// SPDX-License-Identifier: AGPL-3.0-only
// Shared form primitives for the platform guided-forms (cli-form + http-form).
// Extracted at inc 30.7 (rule of three: the arg/param rows in both forms render
// an identical Field-wrapped Select-over-string-options + a required Switch).
// Keeping these as tiny primitives — NOT a whole row abstraction — so each panel
// keeps its own distinctive columns (cli's argv prefix vs http's `in` location).

import {
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "../../ui/index.js"

/**
 * A Field-labelled Select over a fixed list of string options. The single shared
 * shape behind the cli "Type" select, the http "Type" select, and the http
 * "In" (location) select. `onValueChange` receives the raw string — callers cast
 * to their own union (the option list is the source of truth).
 */
export function LabeledSelect<T extends string>({
  id,
  label,
  value,
  options,
  onValueChange,
  className,
}: {
  readonly id: string
  readonly label: string
  readonly value: T
  readonly options: readonly T[]
  readonly onValueChange: (value: string) => void
  readonly className?: string
}) {
  return (
    <Field id={id} label={label} className={className}>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/**
 * The "Required" Switch + label used identically by every declared arg/param row.
 * `pt-5` aligns it with the baseline of the Field-labelled controls beside it.
 */
export function RequiredToggle({
  checked,
  onCheckedChange,
}: {
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2 pt-5">
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label="Required" />
      <span style={{ fontSize: "var(--text-label)", color: "var(--gray-1000)" }}>Required</span>
    </div>
  )
}
