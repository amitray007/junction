// SPDX-License-Identifier: AGPL-3.0-only
// List — a simple selectable list with highlight. Pure presentation; no core calls.

import { Box, Text } from "ink"
import type { ReactElement } from "react"

interface ListProps {
  items: string[]
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
        // Use the item string as key — items in a panel list (profiles/platforms) are unique labels.
        return (
          <Box key={item}>
            <Text color={isSelected ? "green" : undefined} bold={isSelected}>
              {isSelected ? "▶ " : "  "}
              {item}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
