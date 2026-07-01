// SPDX-License-Identifier: AGPL-3.0-only
// FacetSelect — a labeled dropdown filter over a fixed option list, with an
// "All" sentinel that clears the facet. Used for table facet filters (Platforms
// kind, Credentials platform/account/kind). Composes with useTableView's predicate.

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js"

export interface FacetOption {
  /** The value stored in state (and matched against a row field). */
  readonly value: string
  /** The visible label; defaults to `value`. */
  readonly label?: string
}

export interface FacetSelectProps {
  /** Accessible name, e.g. "Filter by kind". */
  readonly ariaLabel: string
  /** The "All X" sentinel label shown when nothing is filtered. */
  readonly allLabel: string
  /** The sentinel value (default "all"). */
  readonly allValue?: string
  readonly options: readonly FacetOption[]
  readonly value: string
  readonly onValueChange: (value: string) => void
}

export function FacetSelect({
  ariaLabel,
  allLabel,
  allValue = "all",
  options,
  value,
  onValueChange,
}: FacetSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={ariaLabel} style={{ maxWidth: "180px" }}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={allValue}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label ?? o.value}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
