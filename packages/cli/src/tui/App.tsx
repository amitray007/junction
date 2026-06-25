// SPDX-License-Identifier: AGPL-3.0-only
// App — full-screen TUI dashboard layout. Holds focus/selection state.
// Pure: receives snapshot via props; no direct core calls inside components.

import { Box, Text, useApp, useInput } from "ink"
import type { ReactElement } from "react"
import { useState } from "react"
import type { DashboardSnapshot } from "./data.js"
import { PlatformsPanel } from "./PlatformsPanel.js"
import { ProfilesPanel } from "./ProfilesPanel.js"
import { StatusPanel } from "./StatusPanel.js"

// 0 = Status, 1 = Profiles, 2 = Platforms
type PanelIndex = 0 | 1 | 2

const PANEL_COUNT = 3

export interface AppProps {
  /** Initial dashboard snapshot to display. */
  snapshot: DashboardSnapshot
  /**
   * Called when the user presses 'r'. Returns a fresh snapshot.
   * Errors are swallowed silently — the dashboard keeps showing stale data.
   */
  onReload: () => Promise<DashboardSnapshot>
}

/** Full-screen Ink dashboard layout. */
export function App({ snapshot: initialSnapshot, onReload }: AppProps): ReactElement {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [focusedPanel, setFocusedPanel] = useState<PanelIndex>(0)
  const [selectedRow, setSelectedRow] = useState(0)
  const { exit } = useApp()

  // Number of navigable items in each panel (Status panel has none)
  const panelItemCounts: [number, number, number] = [
    0,
    snapshot.profiles.length,
    snapshot.platforms.length,
  ]

  useInput((input, key) => {
    if (input === "q") {
      exit()
      return
    }

    if (key.tab) {
      setFocusedPanel((p) => ((p + 1) % PANEL_COUNT) as PanelIndex)
      setSelectedRow(0)
      return
    }

    if (key.upArrow || input === "k") {
      setSelectedRow((r) => Math.max(0, r - 1))
      return
    }

    if (key.downArrow || input === "j") {
      const maxItems = panelItemCounts[focusedPanel] ?? 0
      const maxRow = Math.max(0, maxItems - 1)
      setSelectedRow((r) => Math.min(maxRow, r + 1))
      return
    }

    if (input === "r") {
      onReload()
        .then((fresh) => {
          setSnapshot(fresh)
          setSelectedRow(0)
        })
        .catch(() => {
          // Silently keep showing stale data on reload error
        })
    }
  })

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color="cyan">
          junction
        </Text>
        <Text dimColor> — connect your platforms once, reach them anywhere</Text>
      </Box>

      {/* Main panels row */}
      <Box flexDirection="row">
        <StatusPanel status={snapshot.status} focused={focusedPanel === 0} />
        <ProfilesPanel
          profiles={snapshot.profiles}
          focused={focusedPanel === 1}
          selectedRow={selectedRow}
        />
        <PlatformsPanel
          platforms={snapshot.platforms}
          focused={focusedPanel === 2}
          selectedRow={selectedRow}
        />
      </Box>

      {/* Footer with keybinding hints */}
      <Box paddingX={1}>
        <Text dimColor>Tab next panel ↑/↓ navigate r reload q quit</Text>
      </Box>
    </Box>
  )
}
