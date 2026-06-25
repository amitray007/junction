// SPDX-License-Identifier: AGPL-3.0-only
// List — a simple selectable list with highlight. Pure presentation; no core calls.

import { Box, Text } from "ink"
import type { ReactElement } from "react"

/** A list row: a stable `id` (React key) + the display `label`. */
export interface ListItem {
  id: string
  label: string
}

interface ListProps {
  items: ListItem[]
  selectedRow: number
  focused: boolean
}

/** Renders a list of text items with a selection highlight on the focused row. */
export function List({ items, selectedRow, focused }: ListProps): ReactElement {
  if (items.length === 0) {
    return (
      <Box>
        <Text dimColor>—</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {items.map((item, idx) => {
        const isSelected = idx === selectedRow && focused
        // Key on the stable id, not the label — the multi-account wedge means two
        // credentials/profiles can render identical labels (e.g. two GitHub accounts).
        return (
          <Box key={item.id}>
            <Text color={isSelected ? "green" : undefined} bold={isSelected}>
              {isSelected ? "▶ " : "  "}
              {item.label}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
