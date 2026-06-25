// SPDX-License-Identifier: AGPL-3.0-only
// ProfilesPanel — profiles list display. Pure presentation; no core calls.

import { Box, Text } from "ink"
import type { ReactElement } from "react"
import type { DashboardProfile } from "./data.js"
import { List } from "./List.js"

interface ProfilesPanelProps {
  profiles: DashboardProfile[]
  focused: boolean
  selectedRow: number
}

/** Renders the profiles panel with a selectable list. */
export function ProfilesPanel({
  profiles,
  focused,
  selectedRow,
}: ProfilesPanelProps): ReactElement {
  const items = profiles.map(
    (p) => `${p.name.padEnd(16)} ${String(p.sourceCount).padEnd(3)} src  ${p.mcpEndpointPath}`,
  )

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "green" : "gray"}
      paddingX={1}
      flexGrow={1}
    >
      <Box marginBottom={1}>
        <Text bold color={focused ? "green" : "white"}>
          Profiles
        </Text>
      </Box>
      {profiles.length === 0 ? (
        <Text dimColor>No profiles yet.</Text>
      ) : (
        <>
          <Box>
            <Text dimColor>{"name              src  endpoint"}</Text>
          </Box>
          <List items={items} selectedRow={selectedRow} focused={focused} />
        </>
      )}
    </Box>
  )
}
