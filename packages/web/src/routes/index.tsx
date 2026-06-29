// SPDX-License-Identifier: AGPL-3.0-only
// Dashboard route — 2-col layout (inc 24.6): Connect an Agent (primary) + At-a-Glance + System (secondary).
// No @junction/core import.
// Layout: .dashboard-grid CSS class (app.css) — 2-col above 48rem, 1-col stack below.
// Connect-an-Agent (grid-row: 1 / span 2) is the visual focal point.

import { createFileRoute } from "@tanstack/react-router"
import type { CSSProperties, ReactNode } from "react"
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
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
      <PageHeader title="Dashboard" />

      {/* .dashboard-grid (app.css): 2-col above 48rem (--dashboard-breakpoint), stacks to
          1-col below via @media. Connect spans both grid rows as the primary focal point.
          Source order: Connect first (keyboard/reader priority), secondary panels follow. */}
      <div className="dashboard-grid">
        {/* PRIMARY — Connect an Agent spans both rows in the primary column */}
        {/* ComingSoon surface; NO working http endpoint */}
        <section aria-labelledby="connect-heading" style={{ gridRow: "1 / span 2" }}>
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

        {/* SECONDARY row 1 — At a Glance: compact stat strip, no card wrapper */}
        <section aria-labelledby="glance-heading">
          <SectionLabel id="glance-heading">At a Glance</SectionLabel>
          <ul
            aria-label="Summary counts"
            style={{
              display: "flex",
              gap: "24px",
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

        {/* SECONDARY row 2 — System: quiet detail card */}
        <section aria-labelledby="status-heading">
          <SectionLabel id="status-heading">System</SectionLabel>
          <Card>
            <CardContent style={{ padding: "12px 16px" }}>
              <dl
                style={{
                  display: "grid",
                  gridTemplateColumns: "max-content 1fr",
                  columnGap: "16px",
                  rowGap: "6px",
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
      </div>

      {/* Recent Activity — quiet footer (ComingSoon, audit inc 29) */}
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

// SectionLabel — secondary section headings (At a Glance / System / Recent Activity).
// Uppercase, text-label weight, gray-700. Used 3× in this file — rule-of-three.
// The primary "Connect an Agent" heading is a distinct h2/text-h2 style (single occurrence).
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
        // margin: "0 0 10px" — top/right/left zero; 10px bottom default (overridable via style)
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
      <dt
        style={{
          fontSize: "var(--text-body)",
          color: "var(--gray-700)",
          fontWeight: 500,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          fontSize: mono ? "var(--text-mono)" : "var(--text-body)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          color: "var(--gray-900)",
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
