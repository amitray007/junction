// SPDX-License-Identifier: AGPL-3.0-only
// Settings route — STUB for Phase 1 typed-router compatibility.
// Phase 3 (D5) will flesh this out with the MCP host form + theme toggle.
// No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "../ui/page-header.js"

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <div>
      <PageHeader title="Settings" subtitle="Coming in this increment." />
    </div>
  )
}
