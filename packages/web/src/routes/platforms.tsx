// SPDX-License-Identifier: AGPL-3.0-only
// Platforms route — lighter re-skin. Add Platform = ComingSoon (inc 25).
// No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { getCredentials, getPlatforms, type PlatformMeta } from "../server/data.functions.js"
import { ComingSoonAction } from "../ui/coming-soon.js"
import { PageHeader } from "../ui/page-header.js"
import { TableSkeleton } from "../ui/skeleton.js"
import { EmptyState } from "../ui/states.js"
import {
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
        actions={<ComingSoonAction label="Add Platform" cliHint="junction platform add" />}
      />

      {platforms.length === 0 ? (
        <EmptyState
          label="No platforms yet."
          hint={
            <span>
              Run{" "}
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-mono)",
                  color: "var(--blue-text)",
                }}
              >
                junction platform add
              </code>{" "}
              to add one.
            </span>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Connections</TableHead>
              <TableHead>Base URL</TableHead>
              <TableActionsHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {platforms.map((p: PlatformMeta) => (
              <TableRow key={p.id}>
                <TableCell style={{ fontWeight: 500 }}>{p.displayName}</TableCell>
                <TableCell>
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-mono)",
                      color: "var(--blue-text)",
                      backgroundColor: "var(--blue-bg)",
                      borderRadius: "var(--radius-6)",
                      padding: "1px 6px",
                    }}
                  >
                    {p.kind}
                  </code>
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
                <TableCell>
                  {p.baseUrl ? (
                    <code
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-mono)",
                        color: "var(--gray-900)",
                        wordBreak: "break-all",
                      }}
                    >
                      {p.baseUrl}
                    </code>
                  ) : (
                    <span style={{ color: "var(--gray-600)" }}>—</span>
                  )}
                </TableCell>
                {/* No row actions yet — wired in inc 25 */}
                <TableActionsCell />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
