// SPDX-License-Identifier: AGPL-3.0-only
// StatusPanel — read-only status display. Pure presentation; no core calls.

import { Box, Text } from "ink"
import type { ReactElement } from "react"
import type { DashboardStatus } from "./data.js"

interface StatusPanelProps {
  status: DashboardStatus
  focused: boolean
}

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <Box>
      <Text dimColor>{label.padEnd(18)}</Text>
      <Text>{value}</Text>
    </Box>
  )
}

/** Renders the junction status panel (home, config, credential-store, sandbox). */
export function StatusPanel({ status, focused }: StatusPanelProps): ReactElement {
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
          Status
        </Text>
      </Box>
      <Row label="home" value={status.home} />
      <Row label="config" value={status.configFile} />
      <Row label="initialized" value={String(status.initialized)} />
      <Row label="credential store" value={status.credentialStore} />
      <Row label="sandbox" value={status.sandbox} />
    </Box>
  )
}
