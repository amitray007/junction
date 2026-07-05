// SPDX-License-Identifier: AGPL-3.0-only
// KeyValueRepeater — a [key][value][×] row list with an "Add" button, optionally
// behind a collapse toggle showing a live count summary. Shared shape behind
// platforms.tsx's stdio Env Vars field, cli-form's Static Env Vars repeater, and
// http-form's Default Headers repeater — three consumers of one row primitive
// (rule of three), differing only in labels/placeholders and whether it starts
// collapsed.

import { Plus, X } from "lucide-react"
import { useState } from "react"
import { Button, Input } from "../../ui/index.js"

export interface KeyValueRow {
  readonly id: string
  key: string
  value: string
}

export interface KeyValueRepeaterProps {
  readonly label: string
  readonly rows: KeyValueRow[]
  readonly onChange: (rows: KeyValueRow[]) => void
  readonly keyPlaceholder?: string
  readonly valuePlaceholder?: string
  readonly addLabel?: string
  readonly removeAriaLabel?: string
  /** When provided, the list renders behind a collapsible header instead of always-open. */
  readonly collapsible?: boolean
  /** Initial expansion state when `collapsible` is true. Ignored otherwise. Default: false. */
  readonly defaultExpanded?: boolean
  readonly makeRow: () => KeyValueRow
}

export function KeyValueRepeater({
  label,
  rows,
  onChange,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
  addLabel = "Add Variable",
  removeAriaLabel = "Remove entry",
  collapsible = false,
  defaultExpanded = false,
  makeRow,
}: KeyValueRepeaterProps) {
  const [expanded, setExpanded] = useState(!collapsible || defaultExpanded)

  const list = (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={row.id} className="flex gap-2">
          <Input
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(e) => {
              const next = [...rows]
              next[i] = { ...row, key: e.target.value }
              onChange(next)
            }}
          />
          <Input
            placeholder={valuePlaceholder}
            value={row.value}
            onChange={(e) => {
              const next = [...rows]
              next[i] = { ...row, value: e.target.value }
              onChange(next)
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={removeAriaLabel}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        onClick={() => onChange([...rows, makeRow()])}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  )

  if (!collapsible) {
    return (
      <div className="flex flex-col gap-2">
        <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
          {label}
        </span>
        {list}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="flex items-center justify-between text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
          {label}
        </span>
        <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
          {rows.length} set
        </span>
      </button>
      {expanded && list}
    </div>
  )
}
