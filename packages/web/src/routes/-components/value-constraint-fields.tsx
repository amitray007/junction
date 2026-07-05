// SPDX-License-Identifier: AGPL-3.0-only
// ValueConstraintFields — the enum-values Field + collapsible Pattern/MaxLength
// disclosure shared by cli-form's ArgRow and http-form's ParamRow: both declare
// a value with {type, enumValues, pattern, maxLength} and render the identical
// constraints UI (rule-of-three-honest extraction — two consumers today, same
// shape). Row-specific chrome (name/description/location/required) stays in
// each caller; only this narrow, genuinely-identical sub-block is shared.

import { ChevronDown, ChevronRight } from "lucide-react"
import { useState } from "react"
import { Field, Input } from "../../ui/index.js"

/** The three constraint fields shared by every declared arg/param row. */
export interface ValueConstraints {
  readonly enumValues: string[]
  readonly pattern: string
  readonly maxLength: string
}

export interface ValueConstraintFieldsProps extends ValueConstraints {
  /** Stable id prefix for this row — e.g. `arg-${key}` or `param-${key}`. */
  readonly idPrefix: string
  readonly type: string
  /** A single patch callback — both callers' row `onChange` already takes a Partial. */
  readonly onChange: (patch: Partial<ValueConstraints>) => void
}

/** Enum-values Field + collapsible Pattern/MaxLength "Constraints" disclosure. */
export function ValueConstraintFields({
  idPrefix,
  type,
  enumValues,
  pattern,
  maxLength,
  onChange,
}: ValueConstraintFieldsProps) {
  const [constraintsOpen, setConstraintsOpen] = useState(false)

  return (
    <>
      {type === "enum" && (
        <Field id={`${idPrefix}-enum`} label="Allowed Values" description="Comma-separated.">
          <Input
            id={`${idPrefix}-enum`}
            value={enumValues.join(", ")}
            onChange={(e) =>
              onChange({
                enumValues: e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      )}

      <button
        type="button"
        className="flex items-center gap-1 self-start"
        onClick={() => setConstraintsOpen((v) => !v)}
        aria-expanded={constraintsOpen}
      >
        {constraintsOpen ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
          Constraints
        </span>
      </button>

      {constraintsOpen && (
        <div className="flex gap-2">
          <Field id={`${idPrefix}-pattern`} label="Pattern" className="flex-1">
            <Input
              id={`${idPrefix}-pattern`}
              placeholder="regex, anchored"
              value={pattern}
              onChange={(e) => onChange({ pattern: e.target.value })}
            />
          </Field>
          <Field id={`${idPrefix}-maxlength`} label="Max Length" className="flex-1">
            <Input
              id={`${idPrefix}-maxlength`}
              type="number"
              max={4096}
              value={maxLength}
              onChange={(e) => onChange({ maxLength: e.target.value })}
            />
          </Field>
        </div>
      )}
    </>
  )
}
