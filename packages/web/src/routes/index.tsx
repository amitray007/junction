// SPDX-License-Identifier: AGPL-3.0-only
// Dashboard route — counts + system status cards.
// No @junction/core import; data flows through server functions only.

import { createFileRoute } from "@tanstack/react-router"
import { Database, Key, LayoutList } from "lucide-react"
import { getDashboard } from "../server/data.functions.js"
import { Card, CardContent } from "../ui/card.js"
import { EmptyState } from "../ui/states.js"

export const Route = createFileRoute("/")({
  loader: () => getDashboard(),
  component: DashboardPage,
})

function DashboardPage() {
  const data = Route.useLoaderData()
  return (
    <div>
      {/* Page title */}
      <h1
        className="mb-6"
        style={{
          fontSize: "var(--text-page-title)",
          fontWeight: 600,
          letterSpacing: "var(--tracking-tight)",
          color: "var(--fg)",
        }}
      >
        Dashboard
      </h1>

      {/* Stat cards */}
      <ul className="grid grid-cols-3 gap-4 mb-8 list-none m-0 p-0" aria-label="Summary counts">
        <StatCard
          icon={<LayoutList className="h-4 w-4" aria-hidden="true" />}
          value={data.counts.platforms}
          label="Platforms"
        />
        <StatCard
          icon={<Key className="h-4 w-4" aria-hidden="true" />}
          value={data.counts.credentials}
          label="Credentials"
        />
        <StatCard
          icon={<Database className="h-4 w-4" aria-hidden="true" />}
          value={data.counts.profiles}
          label="Profiles"
        />
      </ul>

      {/* System info */}
      <section aria-label="System status">
        <p
          className="mb-2 uppercase tracking-eyebrow"
          style={{
            fontSize: "var(--text-eyebrow)",
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontWeight: 500,
          }}
        >
          System
        </p>
        <Card>
          <CardContent>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-2">
              <InfoRow label="Home" value={data.home} mono />
              <InfoRow label="Initialized" value={data.initialized ? "Yes" : "No"} />
              <InfoRow label="Credential store" value={data.credentialStore} />
              <InfoRow label="Sandbox" value={data.sandbox} />
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* First-run hint when nothing configured yet */}
      {data.counts.platforms === 0 &&
        data.counts.credentials === 0 &&
        data.counts.profiles === 0 && (
          <EmptyState
            className="mt-8"
            label="Nothing configured yet."
            hint={
              <span>
                Run{" "}
                <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}>
                  junction platform add
                </code>{" "}
                to get started.
              </span>
            }
          />
        )}
    </div>
  )
}

function StatCard({
  icon,
  value,
  label,
}: {
  readonly icon: React.ReactNode
  readonly value: number
  readonly label: string
}) {
  return (
    <li aria-label={`${value} ${label}`} className="list-none">
      <Card>
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span style={{ color: "var(--muted)" }}>{icon}</span>
          </div>
          <div
            style={{
              fontSize: "var(--text-stat)",
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              color: "var(--fg)",
              lineHeight: 1,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value}
          </div>
          <div style={{ fontSize: "var(--text-body)", color: "var(--muted)" }}>{label}</div>
        </CardContent>
      </Card>
    </li>
  )
}

function InfoRow({
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
      <dt style={{ fontSize: "var(--text-body)", color: "var(--muted)", fontWeight: 500 }}>
        {label}
      </dt>
      <dd
        style={{
          fontSize: mono ? "var(--text-mono)" : "var(--text-body)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          color: "var(--fg)",
          margin: 0,
          wordBreak: "break-all",
        }}
      >
        {value}
      </dd>
    </>
  )
}
