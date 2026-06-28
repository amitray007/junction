// SPDX-License-Identifier: AGPL-3.0-only
// Credentials list route — metadata only, never secret or secretRef.
// No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { type CredentialMeta, getCredentials } from "../server/data.functions.js"
import { StatusBadge } from "../ui/badge.js"
import { EmptyState } from "../ui/states.js"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.js"

export const Route = createFileRoute("/credentials")({
  loader: () => getCredentials(),
  component: CredentialsPage,
})

// Map credential kind to a badge status.
// All stored credentials are connected (they've been added successfully);
// we don't have live-validity state yet (that lands with OAuth in inc 28).
function kindToStatus(kind: string): "connected" | "no-auth" | "disabled" {
  if (kind === "none") return "no-auth"
  return "connected"
}

function CredentialsPage() {
  const credentials = Route.useLoaderData()
  return (
    <div>
      <h1
        className="mb-6"
        style={{
          fontSize: "var(--text-page-title)",
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--fg)",
        }}
      >
        Credentials
      </h1>

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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
