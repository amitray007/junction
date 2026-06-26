// SPDX-License-Identifier: AGPL-3.0-only
// ProfilesPanel — profiles list display with per-source rows. Pure presentation; no core calls.
// SECURITY: sources contain only routing metadata (namespace, platformId, enabled).
// secretRef and plaintext secrets never appear here.

import { Box, Text } from "ink"
import type { ReactElement } from "react"
import type { DashboardProfile } from "./data.js"

interface ProfilesPanelProps {
  profiles: DashboardProfile[]
  focused: boolean
  selectedRow: number
}

/** Renders the profiles panel with per-source rows (namespace · platform · enabled glyph). */
export function ProfilesPanel({
  profiles,
  focused,
  selectedRow,
}: ProfilesPanelProps): ReactElement {
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
        profiles.map((p, profileIdx) => {
          const isSelected = profileIdx === selectedRow && focused
          return (
            <Box key={p.id} flexDirection="column" marginBottom={p.sources.length > 0 ? 1 : 0}>
              <Box>
                <Text color={isSelected ? "green" : undefined} bold={isSelected}>
                  {isSelected ? "▶ " : "  "}
                  {p.name.padEnd(16)}
                  {"  "}
                  {p.mcpEndpointPath}
                </Text>
              </Box>
              {p.sources.map((src) => (
                <Box key={src.namespace} marginLeft={4}>
                  <Text dimColor={!src.enabled}>
                    {src.enabled ? "✓" : "✗"} {src.namespace} · {src.platformId}
                    {!src.enabled ? " (disabled)" : ""}
                  </Text>
                </Box>
              ))}
            </Box>
          )
        })
      )}
    </Box>
  )
}
