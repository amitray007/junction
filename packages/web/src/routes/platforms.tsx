// SPDX-License-Identifier: AGPL-3.0-only
// Platforms route — lighter re-skin. Add Platform = ComingSoon (inc 25).
// inc 24.6: Base URL column removed (always `—`; noise). baseUrl shown inline under Name when present.
// No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { getCredentials, getPlatforms, type PlatformMeta } from "../server/data.functions.js"
import { MonoChip, MonoCode } from "../ui/code.js"
import { PageHeader } from "../ui/page-header.js"
import { TableSkeleton } from "../ui/skeleton.js"
import {
  EmptyTableRow,
  Table,
  TableActionsCell,
  TableActionsHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table.js"

export const Route = createFileRoute("/platforms")({
  loader: async () => {
    const [platforms, credentials] = await Promise.all([getPlatforms(), getCredentials()])
    // Derive connection counts per platform from the credential list.
    const connectionCounts = new Map<string, number>()
    for (const c of credentials) {
      connectionCounts.set(c.platformId, (connectionCounts.get(c.platformId) ?? 0) + 1)
    }
    return { platforms, connectionCounts: Object.fromEntries(connectionCounts) }
  },
  pendingComponent: PlatformsPending,
  component: PlatformsPage,
})

function PlatformsPending() {
  return (
    <div>
      <PageHeader title="Platforms" />
      <TableSkeleton
        rows={3}
        columns={[
          { width: "w-32" },
          { width: "w-24" },
          { width: "w-16" },
          { flex: true },
          { width: "w-8" },
        ]}
      />
    </div>
  )
}

function PlatformsPage() {
  const { platforms, connectionCounts } = Route.useLoaderData()
  return (
    <div>
      <PageHeader
        title="Platforms"
        count={platforms.length > 0 ? platforms.length : undefined}
        // inc 24.6: simplified to a single quiet inline hint (no disabled button + pill cluster).
        actions={
          <span style={{ fontSize: "var(--text-body)", color: "var(--gray-600)" }}>
            Add via <MonoCode style={{ color: "var(--blue-text)" }}>junction platform add</MonoCode>{" "}
            — UI coming soon
          </span>
        }
      />

      {/* B3: always render the table — empty state is a full-width row, not bare text */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Connections</TableHead>
            {/* Base URL column removed inc 24.6 — always `—` for MCP platforms, pure noise. */}
            <TableActionsHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {platforms.length === 0 ? (
            <EmptyTableRow
              colSpan={4}
              message="No platforms yet."
              action={
                <span style={{ fontSize: "var(--text-body)", color: "var(--gray-700)" }}>
                  Run{" "}
                  <MonoCode style={{ color: "var(--blue-text)" }}>junction platform add</MonoCode>{" "}
                  to add one.
                </span>
              }
            />
          ) : (
            platforms.map((p: PlatformMeta) => (
              <TableRow key={p.id}>
                <TableCell>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <span style={{ fontWeight: 500 }}>{p.displayName}</span>
                    {/* baseUrl shown inline only when present — avoids the always-empty column */}
                    {p.baseUrl ? (
                      <MonoCode style={{ color: "var(--gray-600)", fontSize: "var(--text-mono)" }}>
                        {p.baseUrl}
                      </MonoCode>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <MonoChip>{p.kind}</MonoChip>
                </TableCell>
                <TableCell>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-mono)",
                      color: "var(--gray-900)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {connectionCounts[p.id] ?? 0}
                  </span>
                </TableCell>
                {/* No row actions yet — wired in inc 25 */}
                <TableActionsCell />
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
