// SPDX-License-Identifier: AGPL-3.0-only
// Platforms list route. No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { getPlatforms, type PlatformMeta } from "../server/data.functions.js"
import { EmptyState } from "../ui/states.js"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.js"

export const Route = createFileRoute("/platforms")({
  loader: () => getPlatforms(),
  component: PlatformsPage,
})

function PlatformsPage() {
  const platforms = Route.useLoaderData()
  return (
    <div>
      <h1
        className="mb-6"
        style={{
          fontSize: "var(--text-page-title)",
          fontWeight: 600,
          letterSpacing: "var(--tracking-tight)",
          color: "var(--fg)",
        }}
      >
        Platforms
      </h1>

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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
