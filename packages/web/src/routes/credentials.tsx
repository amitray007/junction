// SPDX-License-Identifier: AGPL-3.0-only
// Credentials list route — metadata only, never secret or secretRef.
// No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { type CredentialMeta, getCredentials } from "../server/data.functions.js"
import { StatusBadge } from "../ui/badge.js"
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

export const Route = createFileRoute("/credentials")({
  loader: () => getCredentials(),
  pendingComponent: CredentialsPending,
  component: CredentialsPage,
})

// Map credential kind to a badge status.
// All stored credential kinds mean the credential was added successfully.
// Show "Configured" — neutral, no liveness claim — until inc 28 adds live probing.
function kindToStatus(_kind: string): "configured" {
  return "configured"
}

function CredentialsPending() {
  return (
    <div>
      <PageHeader title="Credentials" />
      <TableSkeleton
        rows={4}
        columns={[
          { width: "w-40" },
          { width: "w-32" },
          { flex: true },
          { width: "w-24" },
          { width: "w-20" },
          { width: "w-8" },
        ]}
      />
    </div>
  )
}

function CredentialsPage() {
  const credentials = Route.useLoaderData()
  return (
    <div>
      <PageHeader
        title="Credentials"
        count={credentials.length > 0 ? credentials.length : undefined}
      />

      {credentials.length === 0 ? (
        <EmptyState
          label="No credentials yet."
          hint={
            <span>
              Run{" "}
              <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}>
                junction credential add
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
              <TableHead>Platform</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              {/* Actions column scaffold — wired to data in inc 24+ */}
              <TableActionsHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {credentials.map((c: CredentialMeta) => (
              <TableRow key={c.id}>
                <TableCell>
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}>
                    {c.id}
                  </code>
                </TableCell>
                <TableCell>
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}>
                    {c.platformId}
                  </code>
                </TableCell>
                <TableCell>{c.account}</TableCell>
                <TableCell style={{ color: "var(--muted)" }}>{c.kind}</TableCell>
                <TableCell>
                  <StatusBadge status={kindToStatus(c.kind)} />
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
