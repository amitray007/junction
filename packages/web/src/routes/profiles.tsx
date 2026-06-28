// SPDX-License-Identifier: AGPL-3.0-only
// Profiles list route with joined source metadata. No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { getProfiles, type ProfileMeta, type SourceMeta } from "../server/data.functions.js"
import { StatusBadge } from "../ui/badge.js"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js"
import { PageHeader } from "../ui/page-header.js"
import { Separator } from "../ui/separator.js"
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

export const Route = createFileRoute("/profiles")({
  loader: () => getProfiles(),
  pendingComponent: ProfilesPending,
  component: ProfilesPage,
})

function ProfilesPending() {
  return (
    <div>
      <PageHeader title="Profiles" />
      <TableSkeleton rows={2} columns={[{ flex: true }, { width: "w-40" }]} />
    </div>
  )
}

function ProfilesPage() {
  const profiles = Route.useLoaderData()
  return (
    <div>
      <PageHeader title="Profiles" count={profiles.length > 0 ? profiles.length : undefined} />

      {profiles.length === 0 ? (
        <EmptyState
          label="No profiles yet."
          hint={
            <span>
              Run{" "}
              <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}>
                junction profile create
              </code>{" "}
              to create one.
            </span>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {profiles.map((p: ProfileMeta) => (
            <ProfileCard key={p.id} profile={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProfileCard({ profile }: { readonly profile: ProfileMeta }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <CardTitle>{profile.name}</CardTitle>
          {/* MCP endpoint path — mono, muted */}
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-mono)",
              color: "var(--muted)",
              wordBreak: "break-all",
              textAlign: "right",
              flexShrink: 0,
            }}
            title="MCP endpoint path"
          >
            {profile.mcpEndpointPath}
          </div>
        </div>
      </CardHeader>

      {profile.sources.length > 0 && (
        <>
          <Separator className="mb-4" />
          <CardContent>
            <p
              className="mb-2 uppercase"
              style={{
                fontSize: "var(--text-eyebrow)",
                color: "var(--muted)",
                fontFamily: "var(--font-mono)",
                fontWeight: 500,
                letterSpacing: "var(--tracking-eyebrow)",
              }}
            >
              Sources
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Namespace</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Status</TableHead>
                  {/* Actions column scaffold — wired to data in inc 24+ */}
                  <TableActionsHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {profile.sources.map((s: SourceMeta) => (
                  <TableRow key={s.namespace}>
                    <TableCell>
                      <code
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--text-mono)",
                        }}
                      >
                        {s.namespace}
                      </code>
                    </TableCell>
                    <TableCell>
                      <code
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--text-mono)",
                        }}
                      >
                        {s.platform}
                      </code>
                    </TableCell>
                    <TableCell style={{ color: "var(--muted)" }}>{s.credentialAccount}</TableCell>
                    <TableCell>
                      <StatusBadge status={s.enabled ? "configured" : "disabled"} />
                    </TableCell>
                    {/* Actions cell scaffold — no-op until inc 24+ */}
                    <TableActionsCell />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </>
      )}

      {profile.sources.length === 0 && (
        <>
          <Separator className="mb-4" />
          <CardContent>
            <p style={{ fontSize: "var(--text-body)", color: "var(--muted)" }}>
              No sources configured.
            </p>
          </CardContent>
        </>
      )}
    </Card>
  )
}
