// SPDX-License-Identifier: AGPL-3.0-only
// Dashboard route — status line · Connect an Agent (ComingSoon) · At a Glance · Recent Activity.
// No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { getDashboard } from "../server/data.functions.js"
import { AgentConfig } from "../ui/agent-config.js"
import { Card, CardContent } from "../ui/card.js"
import { MonoCode } from "../ui/code.js"
import { ComingSoon } from "../ui/coming-soon.js"
import { PageHeader } from "../ui/page-header.js"
import { Separator } from "../ui/separator.js"
import { TableSkeleton } from "../ui/skeleton.js"
import { EmptyState } from "../ui/states.js"

export const Route = createFileRoute("/")({
  loader: () => getDashboard(),
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
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-10)" }}>
      <PageHeader title="Dashboard" />

      {/* Status line */}
      <section aria-labelledby="status-heading">
        <h2
          id="status-heading"
          style={{
            fontSize: "var(--text-h2)",
            fontWeight: 600,
            color: "var(--gray-1000)",
            marginBottom: "12px",
          }}
        >
          System
        </h2>
        <Card>
          <CardContent>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "max-content 1fr",
                columnGap: "32px",
                rowGap: "8px",
                margin: 0,
              }}
            >
              <StatusRow label="Store" value={data.credentialStore} />
              <StatusRow label="Sandbox" value={data.sandbox} />
              <StatusRow label="Home" value={data.home} mono />
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* At a Glance — compact stat row, not a hero banner */}
      <section aria-labelledby="glance-heading">
        <h2
          id="glance-heading"
          style={{
            fontSize: "var(--text-h2)",
            fontWeight: 600,
            color: "var(--gray-1000)",
            marginBottom: "12px",
          }}
        >
          At a Glance
        </h2>
        <ul
          aria-label="Summary counts"
          style={{
            display: "flex",
            gap: "32px",
            flexWrap: "wrap",
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
        >
          <StatItem label="Platforms" value={data.counts.platforms} />
          <StatItem label="Credentials" value={data.counts.credentials} />
          <StatItem label="Profiles" value={data.counts.profiles} />
        </ul>
      </section>

      {/* Connect an Agent — ComingSoon surface; NO working http endpoint */}
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
            <AgentConfig />
          </CardContent>
        </Card>
      </section>

      {/* Recent Activity — ComingSoon (audit, inc 29) */}
      <section aria-labelledby="activity-heading">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
          <h2
            id="activity-heading"
            style={{
              fontSize: "var(--text-h2)",
              fontWeight: 600,
              color: "var(--gray-1000)",
              margin: 0,
            }}
          >
            Recent Activity
          </h2>
          <ComingSoon />
        </div>
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
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

function StatusRow({
  label,
  value,
  mono = false,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}) {
  return (
    <>
      <dt style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", fontWeight: 500 }}>
        {label}
      </dt>
      <dd
        style={{
          fontSize: mono ? "var(--text-mono)" : "var(--text-body)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          color: "var(--gray-1000)",
          margin: 0,
          wordBreak: "break-all",
        }}
      >
        {value}
      </dd>
    </>
  )
}

function StatItem({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <li style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <span
        style={{
          fontSize: "var(--text-stat)",
          fontWeight: 600,
          color: "var(--gray-1000)",
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.2,
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: "var(--text-label)", color: "var(--gray-700)" }}>{label}</span>
    </li>
  )
}
