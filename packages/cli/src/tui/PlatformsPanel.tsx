// SPDX-License-Identifier: AGPL-3.0-only
// PlatformsPanel — platforms/credentials list display. Pure presentation; no core calls.
// NEVER renders a secret value — only metadata (displayName, kind, credentialCount).

import { Box, Text } from "ink"
import type { ReactElement } from "react"
import type { DashboardPlatform } from "./data.js"
import { List } from "./List.js"

interface PlatformsPanelProps {
  platforms: DashboardPlatform[]
  focused: boolean
  selectedRow: number
}

/** Renders the platforms/credentials panel with a selectable list. */
export function PlatformsPanel({
  platforms,
  focused,
  selectedRow,
}: PlatformsPanelProps): ReactElement {
  // Only metadata shown — never secretRef or any plaintext credential value.
  const items = platforms.map((p) => ({
    id: p.id,
    label: `${p.displayName.padEnd(16)} ${p.kind.padEnd(8)} ${String(p.credentialCount)} cred(s)`,
  }))

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
          Platforms
        </Text>
      </Box>
      {platforms.length === 0 ? (
        <Text dimColor>No platforms connected.</Text>
      ) : (
        <>
          <Box>
            <Text dimColor>{"name              kind     creds"}</Text>
          </Box>
          <List items={items} selectedRow={selectedRow} focused={focused} />
        </>
      )}
    </Box>
  )
}
