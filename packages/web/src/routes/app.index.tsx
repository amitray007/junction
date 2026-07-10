// SPDX-License-Identifier: AGPL-3.0-only
// /app index route (increment 30) — the Apps surface's browse-catalog page.
// Renders listApps() (the catalog) as the spine, left-joined with the live
// groupByApp() connection groups for a connected/available indicator. A
// synthetic "Other" card appears when any connection attributes to "other"
// (transparency — nothing hidden, design doc §8).
// No @junction/core import. Core access is only inside getApps' createServerFn.
//
// Search + filters + sort (increment 30.5 slice 2): a client-side
// search/facet/sort toolbar over the 45-card catalog grid, mirroring
// credentials.tsx's useTableView + FacetSelect pattern. No pagination — the
// catalog is small enough that narrowing via search/filters is sufficient.

import { createFileRoute, Link } from "@tanstack/react-router"
import { LayoutGrid } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useTableView } from "../lib/use-table-view.js"
import type { AppGroupMeta, AppMeta, AppsData } from "../server/data.functions.js"
import { getApps } from "../server/data.functions.js"
import {
  Badge,
  BrandIcon,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FacetSelect,
  Input,
  MonoChip,
  PageHeader,
} from "../ui/index.js"

export const Route = createFileRoute("/app/")({
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
  iconSlug?: string
  aliases?: string[]
  /** Real oauth signal from AppMeta.auth (a {mode:"oauth2"} entry) — preferred
   *  over the "empty supportedKinds" heuristic for the Method=oauth facet. */
  hasOauth: boolean
  /** Curated help.category labels (may be several); absent/empty = uncategorized. */
  category?: string[]
}

const OTHER_APP: AppCardData = {
  id: "other",
  displayName: "Other",
  supportedKinds: [],
  connectedCount: 0,
  iconSlug: undefined,
  aliases: undefined,
  hasOauth: false,
}

// Facet sentinel — "all" clears that facet (composes as AND across
// status/method + the search box, via useTableView's predicate).
const ALL_FILTER = "all"

const STATUS_OPTIONS = [
  { value: "connected", label: "Connected" },
  { value: "available", label: "Available" },
]

const METHOD_OPTIONS = [
  { value: "mcp", label: "mcp" },
  { value: "openapi", label: "openapi" },
  { value: "graphql", label: "graphql" },
  { value: "cli", label: "cli" },
  { value: "oauth", label: "oauth" },
]

// Category facet sentinel for apps with no help.category (e.g. the synthetic
// "Other" card, or a catalog app not yet curated). Lowercase to stay out of
// the real Title-Case category namespace ("Productivity", "Developer", …).
const UNCATEGORIZED_FILTER = "uncategorized"

/**
 * Pure Category-facet predicate — exported for direct unit coverage (happy-dom
 * cannot drive the Radix Select portal open, so the open→choose→filter UI path
 * can't be tested there; see the header comment in -app.index.test.tsx).
 */
export function matchesCategory(
  app: { readonly category?: readonly string[] },
  filter: string,
): boolean {
  if (filter === ALL_FILTER) return true
  if (filter === UNCATEGORIZED_FILTER) {
    return app.category === undefined || app.category.length === 0
  }
  return app.category?.includes(filter) ?? false
}

function AppCard({ app }: { readonly app: AppCardData }) {
  const connected = app.connectedCount > 0
  return (
    <Link
      to="/app/$id"
      params={{ id: app.id }}
      className="block no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1 rounded-[var(--radius-12)]"
    >
      <Card className="h-full transition-colors duration-[var(--motion-fast)] hover:bg-[var(--gray-100)]">
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <BrandIcon slug={app.iconSlug} displayName={app.displayName} />
            <CardTitle>{app.displayName}</CardTitle>
          </div>
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
          ) : app.id === "other" ? (
            <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              Connections that don't match a known app
            </span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <MonoChip>oauth</MonoChip>
            </div>
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
      iconSlug: app.iconSlug,
      aliases: app.aliases,
      hasOauth: app.auth?.some((a) => a.mode === "oauth2") ?? app.supportedKinds.length === 0,
      category: app.category,
    }))
    const hasOther = (connectedCounts.get("other") ?? 0) > 0
    return hasOther
      ? [...catalogCards, { ...OTHER_APP, connectedCount: connectedCounts.get("other") ?? 0 }]
      : catalogCards
  }, [catalog, connectedCounts])

  const [statusFilter, setStatusFilter] = useState(ALL_FILTER)
  const [methodFilter, setMethodFilter] = useState(ALL_FILTER)
  const [categoryFilter, setCategoryFilter] = useState(ALL_FILTER)

  // Category options are DERIVED from the loaded catalog (unique, sorted) so a
  // future catalog category shows up without a code change, plus a fixed
  // Uncategorized bucket for apps with no help.category.
  const categoryOptions = useMemo(() => {
    const values = new Set<string>()
    for (const app of cards) {
      for (const c of app.category ?? []) {
        // Guard the sentinel namespace: core's schema allows any non-empty
        // string, so a curated category literally named "Uncategorized"/"All"
        // must not collide with the synthetic all/uncategorized options.
        const lower = c.toLowerCase()
        if (lower === UNCATEGORIZED_FILTER || lower === ALL_FILTER) continue
        values.add(c)
      }
    }
    return [
      ...[...values].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v })),
      { value: UNCATEGORIZED_FILTER, label: "Uncategorized" },
    ]
  }, [cards])
  // A–Z toggle: false = ascending (default), true = descending. Connected-first
  // stays the primary sort key regardless of direction (see nameCompare below).
  const [reverseAlpha, setReverseAlpha] = useState(false)

  const predicate = useCallback(
    (app: AppCardData) => {
      const statusOk =
        statusFilter === ALL_FILTER ||
        (statusFilter === "connected" ? app.connectedCount > 0 : app.connectedCount === 0)
      const methodOk =
        methodFilter === ALL_FILTER ||
        (methodFilter === "oauth" ? app.hasOauth : app.supportedKinds.includes(methodFilter))
      const categoryOk = matchesCategory(app, categoryFilter)
      return statusOk && methodOk && categoryOk
    },
    [statusFilter, methodFilter, categoryFilter],
  )

  // Default order: connected-first, then A–Z (or Z–A when toggled). Connected
  // status is always the primary key — the toggle only flips the alphabetical
  // direction within/across that grouping.
  const nameCompare = useCallback(
    (a: AppCardData, b: AppCardData) => {
      const aConnected = a.connectedCount > 0
      const bConnected = b.connectedCount > 0
      if (aConnected !== bConnected) return aConnected ? -1 : 1
      const cmp = a.displayName.localeCompare(b.displayName)
      return reverseAlpha ? -cmp : cmp
    },
    [reverseAlpha],
  )

  const { search, setSearch, filteredSortedRows } = useTableView({
    rows: cards,
    searchFields: (app) => [app.id, app.displayName, ...(app.aliases ?? [])],
    columns: [{ key: "name", compare: nameCompare }],
    initialSortKey: "name",
    predicate,
  })

  const visibleCards = filteredSortedRows

  const isFiltered =
    search.trim().length > 0 ||
    statusFilter !== ALL_FILTER ||
    methodFilter !== ALL_FILTER ||
    categoryFilter !== ALL_FILTER

  return (
    <div>
      <PageHeader title="Apps" count={cards.length > 0 ? cards.length : undefined} />

      {cards.length === 0 ? (
        <EmptyState icon={<LayoutGrid className="h-5 w-5" />} label="No apps in the catalog yet." />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-[var(--space-2)]">
            <Input
              id="app-search"
              type="search"
              placeholder="Search apps"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ maxWidth: "320px" }}
              aria-label="Search apps"
            />
            <FacetSelect
              ariaLabel="Filter by status"
              allLabel="All statuses"
              allValue={ALL_FILTER}
              value={statusFilter}
              onValueChange={setStatusFilter}
              options={STATUS_OPTIONS}
            />
            <FacetSelect
              ariaLabel="Filter by method"
              allLabel="All methods"
              allValue={ALL_FILTER}
              value={methodFilter}
              onValueChange={setMethodFilter}
              options={METHOD_OPTIONS}
            />
            <FacetSelect
              ariaLabel="Filter by category"
              allLabel="All categories"
              allValue={ALL_FILTER}
              value={categoryFilter}
              onValueChange={setCategoryFilter}
              options={categoryOptions}
            />
            <button
              type="button"
              onClick={() => setReverseAlpha((v) => !v)}
              aria-label={reverseAlpha ? "Sort Z to A" : "Sort A to Z"}
              className="inline-flex items-center rounded-[var(--radius-6)] border border-[var(--alpha-400)] px-3 text-[var(--text-body)] text-[var(--gray-900)] hover:bg-[var(--gray-100)] transition-colors duration-[var(--motion-fast)]"
            >
              {reverseAlpha ? "Z–A" : "A–Z"}
            </button>
          </div>

          {visibleCards.length === 0 ? (
            isFiltered ? (
              <EmptyState
                icon={<LayoutGrid className="h-5 w-5" />}
                label="No apps match your filters."
              />
            ) : (
              <EmptyState
                icon={<LayoutGrid className="h-5 w-5" />}
                label="No apps in the catalog yet."
              />
            )
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleCards.map((app) => (
                <AppCard key={app.id} app={app} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
