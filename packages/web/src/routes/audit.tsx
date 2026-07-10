// SPDX-License-Identifier: AGPL-3.0-only
// Audit route — a real, filterable table over junction's tool-call audit log
// (increment 32.6b). The audit backend (pino structured logging) shipped in
// increment 31; this replaces the former ComingSoon stub now that the log is
// readable. No @junction/core import — reads flow through getAudit (a
// createServerFn) → audit.server.ts, the ONLY module that touches
// @junction/core for this page.
//
// Mirrors the credentials.tsx canonical table pattern: useTableView for
// search/sort/pagination, FacetSelect for facet filters, no per-row actions
// (this table is read-only), an honest EmptyState, and a subtle truncated-tail
// note when the log exceeds the server-side byte cap.

import { createFileRoute } from "@tanstack/react-router"
import { ScrollText } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import type { TableColumn } from "../lib/use-table-view.js"
import { useTableView } from "../lib/use-table-view.js"
import type { AuditEntryDTO } from "../server/audit.functions.js"
import { getAudit } from "../server/audit.functions.js"
import { MonoCode } from "../ui/code.js"
import {
  Badge,
  EmptyTableRow,
  FacetSelect,
  Input,
  PageHeader,
  RefreshButton,
  Table,
  TableBody,
  TableCell,
  TableCellMono,
  TableHead,
  TableHeader,
  TablePagination,
  TableRow,
  TableSkeleton,
} from "../ui/index.js"
import { EmptyState } from "../ui/states.js"

export const Route = createFileRoute("/audit")({
  loader: async () => getAudit({ data: {} }),
  pendingComponent: AuditPending,
  component: AuditPage,
})

const PAGE_SIZE = 25
const COL_COUNT = 7

function AuditPending() {
  return (
    <div>
      <PageHeader title="Audit" />
      <TableSkeleton
        rows={4}
        columns={[
          { width: "w-40" },
          { width: "w-32" },
          { width: "w-24" },
          { flex: true },
          { width: "w-20" },
          { width: "w-16" },
          { width: "w-20" },
        ]}
      />
    </div>
  )
}

// Deterministic, SSR-safe date format — pinned to UTC so the server (SSR) and
// the browser (hydration) render the BYTE-IDENTICAL string. A locale/timezone
// dependent format (e.g. toLocaleString) flickers on hydrate (inc-27 gotcha:
// docs/futures/gotchas.md; see keys.tsx's formatDate for the same pattern).
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
})

function formatTime(ts: string): string {
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) return ts
  return `${TIME_FORMAT.format(new Date(ms))} UTC`
}

function principalLabel(e: AuditEntryDTO): string {
  if (e.principalKind === "api-key") {
    return e.label ?? e.keyId ?? "unknown key"
  }
  return `stdio:${e.profile}`
}

/**
 * The "Namespace · Tool" cell — a `code_exec` entry has no namespace/tool (it
 * wraps zero or more inner tool_call lines, not one upstream tool call), so
 * it renders a distinct label instead of reading `.tool` unconditionally.
 */
function targetLabel(e: AuditEntryDTO): string {
  if (e.event === "tool_call") return `${e.namespace}__${e.tool}`
  return `code_exec (${e.toolCallCount} call${e.toolCallCount !== 1 ? "s" : ""})`
}

/** Sort/search/facet key for the tool column — code_exec sorts/groups on its own label. */
function targetSortKey(e: AuditEntryDTO): string {
  return e.event === "tool_call" ? `${e.namespace}__${e.tool}` : "code_exec"
}

const ALL_FILTER = "all"

interface AuditTableProps {
  readonly entries: AuditEntryDTO[]
  readonly pageSize?: number
}

// Exported for direct unit testing of the search/facet/pagination logic (the
// pageSize prop lets a test exercise a real second page without 25+ fixtures).
export function AuditTable({ entries, pageSize = PAGE_SIZE }: AuditTableProps) {
  const [profileFilter, setProfileFilter] = useState(ALL_FILTER)
  const [toolFilter, setToolFilter] = useState(ALL_FILTER)
  const [outcomeFilter, setOutcomeFilter] = useState(ALL_FILTER)

  const profileOptions = useMemo(
    () => Array.from(new Set(entries.map((e) => e.profile))).sort((a, b) => a.localeCompare(b)),
    [entries],
  )
  const toolOptions = useMemo(
    () => Array.from(new Set(entries.map(targetLabel))).sort((a, b) => a.localeCompare(b)),
    [entries],
  )

  const predicate = useCallback(
    (e: AuditEntryDTO) =>
      (profileFilter === ALL_FILTER || e.profile === profileFilter) &&
      (toolFilter === ALL_FILTER || targetLabel(e) === toolFilter) &&
      (outcomeFilter === ALL_FILTER || e.outcome === outcomeFilter),
    [profileFilter, toolFilter, outcomeFilter],
  )

  const columns: TableColumn<AuditEntryDTO>[] = useMemo(
    () => [
      { key: "time", compare: (a, b) => Date.parse(a.ts) - Date.parse(b.ts) },
      { key: "profile", compare: (a, b) => a.profile.localeCompare(b.profile) },
      { key: "tool", compare: (a, b) => targetSortKey(a).localeCompare(targetSortKey(b)) },
      { key: "duration", compare: (a, b) => a.durationMs - b.durationMs },
    ],
    [],
  )

  const {
    search,
    setSearch,
    sortDirectionFor,
    toggleSort,
    page,
    pageCount,
    setPage,
    total,
    pageRows,
  } = useTableView<AuditEntryDTO>({
    rows: entries,
    searchFields: (e) => [
      e.profile,
      e.event === "tool_call" ? e.namespace : undefined,
      e.event === "tool_call" ? e.tool : "code_exec",
      e.keyId ?? undefined,
      e.label ?? undefined,
    ],
    columns,
    pageSize,
    predicate,
    initialSortKey: "time",
  })

  const isEmptySearch =
    total === 0 &&
    (search.trim().length > 0 ||
      profileFilter !== ALL_FILTER ||
      toolFilter !== ALL_FILTER ||
      outcomeFilter !== ALL_FILTER)

  return (
    <div className="flex flex-col gap-3">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        <Input
          id="audit-search"
          type="search"
          placeholder="Filter by profile, namespace, tool, or key"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: "320px" }}
          aria-label="Search audit entries"
        />
        <FacetSelect
          ariaLabel="Filter by profile"
          allLabel="All profiles"
          allValue={ALL_FILTER}
          value={profileFilter}
          onValueChange={setProfileFilter}
          options={profileOptions.map((p) => ({ value: p }))}
        />
        <FacetSelect
          ariaLabel="Filter by tool"
          allLabel="All tools"
          allValue={ALL_FILTER}
          value={toolFilter}
          onValueChange={setToolFilter}
          options={toolOptions.map((t) => ({ value: t }))}
        />
        <FacetSelect
          ariaLabel="Filter by outcome"
          allLabel="All outcomes"
          allValue={ALL_FILTER}
          value={outcomeFilter}
          onValueChange={setOutcomeFilter}
          options={[
            { value: "ok", label: "OK" },
            { value: "error", label: "Error" },
          ]}
        />
      </div>

      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead sortDirection={sortDirectionFor("time")} onSort={() => toggleSort("time")}>
                Time
              </TableHead>
              <TableHead>Principal</TableHead>
              <TableHead
                sortDirection={sortDirectionFor("profile")}
                onSort={() => toggleSort("profile")}
              >
                Profile
              </TableHead>
              <TableHead sortDirection={sortDirectionFor("tool")} onSort={() => toggleSort("tool")}>
                Namespace · Tool
              </TableHead>
              <TableHead>Args</TableHead>
              <TableHead
                sortDirection={sortDirectionFor("duration")}
                onSort={() => toggleSort("duration")}
              >
                Duration
              </TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {total === 0 ? (
              <EmptyTableRow
                colSpan={COL_COUNT}
                message={
                  isEmptySearch ? "No audit entries match your search." : "No audit entries yet."
                }
              />
            ) : (
              pageRows.map((e) => (
                // Audit entries have no stable id in the DTO (by design — the
                // reader never surfaces correlationId to the client). Compose
                // a key from every displayed field: two entries sharing ALL of
                // these (same ms, same principal, same target, same duration)
                // would render identically anyway, so a collision is harmless.
                <TableRow
                  key={`${e.ts}|${e.keyId}|${e.profile}|${targetLabel(e)}|${e.durationMs}|${e.outcome}`}
                >
                  <TableCellMono style={{ color: "var(--gray-700)" }}>
                    {formatTime(e.ts)}
                  </TableCellMono>
                  <TableCell>{principalLabel(e)}</TableCell>
                  <TableCellMono>
                    <MonoCode>{e.profile}</MonoCode>
                  </TableCellMono>
                  <TableCellMono>{targetLabel(e)}</TableCellMono>
                  <TableCell>
                    {e.event === "tool_call" ? (
                      e.argKeys.length > 0 ? (
                        <span title={e.argKeys.join(", ")} style={{ color: "var(--gray-700)" }}>
                          {e.argKeys.length} arg{e.argKeys.length !== 1 ? "s" : ""}
                        </span>
                      ) : (
                        <span style={{ color: "var(--gray-700)" }}>—</span>
                      )
                    ) : (
                      <span style={{ color: "var(--gray-700)" }}>—</span>
                    )}
                  </TableCell>
                  <TableCellMono>{e.durationMs}ms</TableCellMono>
                  <TableCell>
                    <span title={e.outcome === "error" ? (e.errorKind ?? undefined) : undefined}>
                      {/* Outcome-specific labels (not connection-status): a tool call
                          is "OK"/"Error", never "Connected"/"Auth Failed" — the errorKind
                          beside it (timeout/rate-limited/…) is frequently not auth-related. */}
                      <Badge variant={e.outcome === "ok" ? "ok" : "error"}>
                        {e.outcome === "ok" ? "OK" : "Error"}
                      </Badge>
                    </span>
                    {e.outcome === "error" && e.errorKind !== null && (
                      <span
                        style={{
                          marginLeft: "var(--space-2)",
                          fontSize: "var(--text-caption)",
                          color: "var(--gray-700)",
                        }}
                      >
                        {e.errorKind}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <TablePagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />
      </div>
    </div>
  )
}

function AuditPage() {
  const { entries, truncated } = Route.useLoaderData()

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <PageHeader
        title="Audit"
        subtitle="A record of tool calls and credential use across your agents."
        actions={<RefreshButton />}
      />

      {truncated && (
        <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
          The audit log is large — showing the most recent entries only.
        </p>
      )}

      {entries.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-5 w-5" aria-hidden="true" />}
          label="No tool calls recorded yet."
          hint={
            <span>
              Once an agent calls a tool through <MonoCode>junction serve</MonoCode>, it appears
              here.
            </span>
          }
        />
      ) : (
        <AuditTable entries={entries} />
      )}
    </div>
  )
}
