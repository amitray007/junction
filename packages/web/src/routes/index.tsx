// SPDX-License-Identifier: AGPL-3.0-only
// Dashboard route — inc 25 phase 2: single-column top→bottom layout.
// Structure: Connect an Agent (hero, Card-outer) → At-a-Glance (stat strip) →
//            System (quiet Card) → Recent Activity (ComingSoon footer).
// .stat-strip (app.css): 3-equal-cell CSS grid — no flex-wrap distortion at any width.
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

      {/* PRIMARY — Connect an Agent (hero block; ONE container = Card). */}
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

      {/* SECONDARY — At a Glance: 3-equal-cell stat strip (.stat-strip in app.css). */}
      {/* CSS grid guarantees equal widths at 1440/1000/700px — no flex-wrap distortion. */}
      <section aria-labelledby="glance-heading">
        <SectionLabel id="glance-heading">At a Glance</SectionLabel>
        <ul
          aria-label="Summary counts"
          className="stat-strip"
          style={{ margin: 0, padding: 0, listStyle: "none" }}
        >
          <StatCell label="Platforms" value={data.counts.platforms} />
          <StatCell label="Credentials" value={data.counts.credentials} />
          <StatCell label="Profiles" value={data.counts.profiles} />
        </ul>
      </section>

      {/* SECONDARY — System: quiet detail (store / sandbox / home), de-emphasized. */}
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

// SectionLabel — secondary section headings (At a Glance / System / Recent Activity).
// Uppercase, text-label weight, gray-700. Used 3× in this file — rule-of-three.
// The primary "Connect an Agent" heading is a distinct h2/text-h2 style (single use).
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

// StatCell — one cell in the At-a-Glance stat strip.
// Padding matches the card-padding rhythm; stat number is --text-stat.
// The strip's border/radius/shadow lives on the <ul.stat-strip> wrapper (app.css).
function StatCell({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <li
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "var(--card-padding)",
      }}
    >
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
