// SPDX-License-Identifier: AGPL-3.0-only
// Dashboard route — Connect an Agent (hero) → Recent Activity.
// System info (Store/Sandbox/Home) moved to the sidebar panel (inc 26).
// No @junction/core import.

import { createFileRoute, Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import { getSettings } from "../server/data.functions.js"
import { AgentConfig } from "../ui/agent-config.js"
import { Card, CardContent } from "../ui/card.js"
import { PageHeader } from "../ui/page-header.js"
import { TableSkeleton } from "../ui/skeleton.js"

export const Route = createFileRoute("/")({
  loader: async () => {
    // Only settings are rendered now (counts/system moved off the dashboard), so fetch
    // just the settings — no dead getDashboard count/label queries on every visit.
    const settings = await getSettings()
    return { mcpHost: settings.mcpHost, mcpPort: settings.mcpPort }
  },
  pendingComponent: DashboardPending,
  component: DashboardPage,
})

function DashboardPending() {
  return (
    <div>
      <PageHeader title="Dashboard" />
      <TableSkeleton rows={3} columns={[{ flex: true }, { width: "w-24" }]} />
    </div>
  )
}

function DashboardPage() {
  const data = Route.useLoaderData()

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
      <PageHeader title="Dashboard" />

      {/* Connect an Agent (hero block; ONE container = Card). */}
      {/* AgentConfig carries no outer border of its own — the Card is the single container. */}
      {/* HONESTY: the endpoint is real (inc 27) but liveness is unknown — AgentConfig always
          carries a "requires junction serve running" note; it never claims the server is up. */}
      <section aria-labelledby="connect-heading">
        <h2
          id="connect-heading"
          style={{
            fontSize: "var(--text-h2)",
            fontWeight: 600,
            color: "var(--gray-1000)",
            marginBottom: "12px",
          }}
        >
          Connect an Agent
        </h2>
        <Card>
          <CardContent>
            <AgentConfig mcpHost={data.mcpHost} mcpPort={data.mcpPort} />
          </CardContent>
        </Card>
      </section>

      {/* Recent Activity — link-card to the real /audit page (inc 32.6b). */}
      <section aria-labelledby="activity-heading">
        <SectionLabel id="activity-heading" style={{ marginBottom: "12px" }}>
          Recent Activity
        </SectionLabel>
        <Link
          to="/audit"
          className="no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1 rounded-[var(--radius-12)]"
        >
          <Card className="transition-colors duration-[var(--motion-fast)] hover:bg-[var(--gray-100)]">
            <CardContent
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
            >
              <p style={{ fontSize: "var(--text-body)", color: "var(--gray-600)", margin: 0 }}>
                View the audit log — a record of tool calls and credential use across your agents.
              </p>
              <ChevronRight
                className="h-4 w-4"
                aria-hidden="true"
                style={{ color: "var(--gray-600)" }}
              />
            </CardContent>
          </Card>
        </Link>
      </section>
    </div>
  )
}

// ─── Dashboard-local primitives ───────────────────────────────────────────────

// SectionLabel — secondary section headings (Recent Activity, etc.).
// Uppercase, text-label weight, gray-700.
// The primary "Connect an Agent" heading is a distinct h2/text-h2 style.
interface SectionLabelProps {
  readonly id?: string
  readonly style?: CSSProperties
  readonly children: ReactNode
}

function SectionLabel({ id, style, children }: SectionLabelProps) {
  return (
    <h2
      id={id}
      style={{
        fontSize: "var(--text-label)",
        fontWeight: 500,
        color: "var(--gray-700)",
        margin: "0 0 10px",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        ...style,
      }}
    >
      {children}
    </h2>
  )
}
