// SPDX-License-Identifier: AGPL-3.0-only
// /app index route (increment 30) — the Apps surface's browse-catalog page.
// Renders listApps() (the catalog) as the spine, left-joined with the live
// groupByApp() connection groups for a connected/available indicator. A
// synthetic "Other" card appears when any connection attributes to "other"
// (transparency — nothing hidden, design doc §8).
// No @junction/core import. Core access is only inside getApps' createServerFn.

import { createFileRoute, Link } from "@tanstack/react-router"
import { LayoutGrid } from "lucide-react"
import { useMemo } from "react"
import type { AppGroupMeta, AppMeta, AppsData } from "../server/data.functions.js"
import { getApps } from "../server/data.functions.js"
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  MonoChip,
  PageHeader,
} from "../ui/index.js"

export const Route = createFileRoute("/app")({
  loader: async () => {
    const data: AppsData = await getApps()
    return data
  },
  component: AppsIndexPage,
})

interface AppCardData {
  id: string
  displayName: string
  supportedKinds: string[]
  connectedCount: number
}

const OTHER_APP: AppCardData = {
  id: "other",
  displayName: "Other",
  supportedKinds: [],
  connectedCount: 0,
}

function AppCard({ app }: { readonly app: AppCardData }) {
  const connected = app.connectedCount > 0
  return (
    <Link
      to="/app/$id"
      params={{ id: app.id }}
      className="no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1 rounded-[var(--radius-12)]"
    >
      <Card className="h-full transition-colors duration-[var(--motion-fast)] hover:bg-[var(--gray-100)]">
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <CardTitle>{app.displayName}</CardTitle>
          {connected ? (
            <Badge variant="ok">{app.connectedCount} connected</Badge>
          ) : (
            <Badge variant="neutral">Available</Badge>
          )}
        </CardHeader>
        <CardContent>
          {app.supportedKinds.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {app.supportedKinds.map((kind) => (
                <MonoChip key={kind}>{kind}</MonoChip>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              OAuth-only — no standable vertical
            </span>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}

function AppsIndexPage() {
  const { catalog, groups }: AppsData = Route.useLoaderData()

  const connectedCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const group of groups as AppGroupMeta[]) {
      counts.set(group.appId, group.connections.length)
    }
    return counts
  }, [groups])

  const cards: AppCardData[] = useMemo(() => {
    const catalogCards = (catalog as AppMeta[]).map((app) => ({
      id: app.id,
      displayName: app.displayName,
      supportedKinds: app.supportedKinds,
      connectedCount: connectedCounts.get(app.id) ?? 0,
    }))
    const hasOther = (connectedCounts.get("other") ?? 0) > 0
    return hasOther
      ? [...catalogCards, { ...OTHER_APP, connectedCount: connectedCounts.get("other") ?? 0 }]
      : catalogCards
  }, [catalog, connectedCounts])

  return (
    <div>
      <PageHeader title="Apps" count={cards.length > 0 ? cards.length : undefined} />

      {cards.length === 0 ? (
        <EmptyState icon={<LayoutGrid className="h-5 w-5" />} label="No apps in the catalog yet." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {cards.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      )}
    </div>
  )
}
