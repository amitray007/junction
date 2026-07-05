// SPDX-License-Identifier: AGPL-3.0-only
// useAccordionExpansion + keyed-list array helpers — the add/remove/update/
// expand-toggle pattern shared by cli-form's CliConnectionForm and http-form's
// HttpConnectionForm: both manage a list of tool cards keyed by a stable
// client-only `key`, with exactly one expanded at a time and a floor of one
// item (can't remove the last). Two consumers, identical shape, differing only
// in the item type and the factory that creates a new one — the state lives in
// the caller's own connection state (onChange-driven, same as every other form
// field here); only the small pure array ops + the expand-toggle hook are
// genuinely shared.

import { useEffect, useRef, useState } from "react"

export interface KeyedItem {
  readonly key: string
}

/**
 * Exactly-one-expanded accordion toggle, seeded from the first item's key.
 *
 * In edit mode the form can mount with an empty `tools` array (initialKey
 * undefined) and fill it once the loader data arrives — `useState(initialKey)`
 * only seeds once, leaving the first card collapsed. So when `initialKey`
 * transitions undefined → defined (data arrived), auto-expand it. We DON'T
 * override a later manual collapse: the sync fires only on that first
 * undefined→defined transition (tracked via a ref), never on subsequent changes.
 * (inc-30.7 CodeRabbit #516.)
 */
export function useAccordionExpansion(initialKey: string | undefined) {
  const [expandedKey, setExpandedKey] = useState<string | undefined>(initialKey)
  const seededRef = useRef(initialKey !== undefined)
  useEffect(() => {
    if (!seededRef.current && initialKey !== undefined) {
      seededRef.current = true
      setExpandedKey(initialKey)
    }
  }, [initialKey])
  return {
    expandedKey,
    toggle(key: string) {
      setExpandedKey((cur) => (cur === key ? undefined : key))
    },
    expand(key: string) {
      setExpandedKey(key)
    },
  }
}

/** Replace the item matching `key` in-place, preserving array order. */
export function updateKeyed<T extends KeyedItem>(items: T[], key: string, next: T): T[] {
  return items.map((item) => (item.key === key ? next : item))
}

/** Remove the item matching `key` — a no-op when only one item remains (floor of one). */
export function removeKeyed<T extends KeyedItem>(items: T[], key: string): T[] {
  if (items.length <= 1) return items
  return items.filter((item) => item.key !== key)
}
