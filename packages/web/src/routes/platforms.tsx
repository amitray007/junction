// SPDX-License-Identifier: AGPL-3.0-only
// Platforms list route. No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { getPlatforms, type PlatformMeta } from "../server/data.functions.js"
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
  loader: () => getPlatforms(),
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
          { flex: true },
          { width: "w-40" },
          { width: "w-8" },
        ]}
      />
    </div>
  )
}

function PlatformsPage() {
  const platforms = Route.useLoaderData()
  return (
    <div>
      <PageHeader title="Platforms" count={platforms.length > 0 ? platforms.length : undefined} />

      {platforms.length === 0 ? (
        <EmptyState
          label="No platforms yet."
          hint={
            <span>
              Run{" "}
              <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}>
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
              <TableHead>ID</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Display name</TableHead>
              <TableHead>Base URL</TableHead>
              {/* Actions column scaffold — wired to data in inc 24+ */}
              <TableActionsHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {platforms.map((p: PlatformMeta) => (
              <TableRow key={p.id}>
                <TableCell>
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}>
                    {p.id}
                  </code>
                </TableCell>
                <TableCell style={{ color: "var(--muted)" }}>{p.kind}</TableCell>
                <TableCell>{p.displayName}</TableCell>
                <TableCell>
                  {p.baseUrl ? (
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}>
                      {p.baseUrl}
                    </code>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>—</span>
                  )}
                </TableCell>
                {/* Actions cell scaffold — no-op until inc 24+ */}
                <TableActionsCell />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
