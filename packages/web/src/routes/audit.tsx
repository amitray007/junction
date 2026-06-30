// SPDX-License-Identifier: AGPL-3.0-only
// Audit route — placeholder for the structured tool-call / credential-use audit log.
// The audit backend (pino structured logging) lands in a later increment (inc 29);
// today this is an honest "coming soon" surface. No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { ScrollText } from "lucide-react"
import { MonoCode } from "../ui/code.js"
import { ComingSoon } from "../ui/coming-soon.js"
import { PageHeader } from "../ui/page-header.js"
import { EmptyState } from "../ui/states.js"

export const Route = createFileRoute("/audit")({
  component: AuditPage,
})

function AuditPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
      <PageHeader
        title="Audit"
        subtitle="A record of tool calls and credential use across your agents."
        actions={<ComingSoon />}
      />

      <EmptyState
        icon={<ScrollText className="h-5 w-5" aria-hidden="true" />}
        label="The audit log isn't available yet."
        hint={
          <span>
            Per-agent tool calls and credential use will be recorded here in a later update — until
            then, follow live activity from the process running{" "}
            <MonoCode style={{ color: "var(--blue-text)" }}>junction mcp serve</MonoCode>.
          </span>
        }
      />
    </div>
  )
}
