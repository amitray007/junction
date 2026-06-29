// SPDX-License-Identifier: AGPL-3.0-only
// Dashboard route — Connect an Agent (hero) → Recent Activity.
// System info (Store/Sandbox/Home) moved to the sidebar panel (inc 26).
// No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import type { CSSProperties, ReactNode } from "react"
import { getDashboard, getSettings } from "../server/data.functions.js"
import { AgentConfig } from "../ui/agent-config.js"
import { Card, CardContent } from "../ui/card.js"
import { MonoCode } from "../ui/code.js"
import { ComingSoon } from "../ui/coming-soon.js"
import { PageHeader } from "../ui/page-header.js"
import { Separator } from "../ui/separator.js"
import { TableSkeleton } from "../ui/skeleton.js"
import { EmptyState } from "../ui/states.js"

export const Route = createFileRoute("/")({
  loader: async () => {
    // Parallel fetch: dashboard counts/system + settings (for the mcpHost in AgentConfig).
    const [dashboard, settings] = await Promise.all([getDashboard(), getSettings()])
    return { ...dashboard, mcpHost: settings.mcpHost }
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
  const isEmpty =
    data.counts.platforms === 0 && data.counts.credentials === 0 && data.counts.profiles === 0

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
      <PageHeader title="Dashboard" />

      {/* Connect an Agent (hero block; ONE container = Card). */}
      {/* AgentConfig carries no outer border of its own — the Card is the single container. */}
      {/* HONESTY: the shared HTTP endpoint isn't live; AgentConfig always carries the note. */}
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
            <AgentConfig mcpHost={data.mcpHost} />
          </CardContent>
        </Card>
      </section>

      {/* Recent Activity — quiet footer (ComingSoon, audit inc 29). */}
      <section aria-labelledby="activity-heading">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
          <SectionLabel id="activity-heading" style={{ margin: 0 }}>
            Recent Activity
          </SectionLabel>
          <ComingSoon />
        </div>
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-600)", margin: 0 }}>
          Per-agent usage and audit log coming in a later update.
        </p>
      </section>

      {/* First-run hint */}
      {isEmpty && (
        <>
          <Separator />
          <EmptyState
            label="Nothing configured yet."
            hint={
              <span>
                Run <MonoCode style={{ color: "var(--blue-text)" }}>junction platform add</MonoCode>{" "}
                to get started.
              </span>
            }
          />
        </>
      )}
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
