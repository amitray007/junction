// SPDX-License-Identifier: AGPL-3.0-only
// Profiles route — full read with route rows. No mutations yet (inc 26).
// mcpEndpointPath is NOT shown (single-endpoint model). No @junction/core import.
// inc 24.6: ComingSoon chrome consolidated — 2 pills+hints per card → 1 quiet CLI affordance.
//           Page header ComingSoonAction cluster → single quiet inline hint.

import { createFileRoute } from "@tanstack/react-router"
import { getProfiles, type ProfileMeta } from "../server/data.functions.js"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js"
import { MonoCode } from "../ui/code.js"
import { ComingSoon } from "../ui/coming-soon.js"
import { PageHeader } from "../ui/page-header.js"
import { RouteRow } from "../ui/route-row.js"
import { Separator } from "../ui/separator.js"
import { TableSkeleton } from "../ui/skeleton.js"
import { EmptyState } from "../ui/states.js"

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
      <PageHeader
        title="Profiles"
        count={profiles.length > 0 ? profiles.length : undefined}
        // inc 24.6: single quiet hint replaces disabled-button + pill + hint cluster
        actions={
          <span style={{ fontSize: "var(--text-body)", color: "var(--gray-600)" }}>
            Create via{" "}
            <MonoCode style={{ color: "var(--blue-text)" }}>junction profile create</MonoCode> — UI
            coming soon
          </span>
        }
      />

      {profiles.length === 0 ? (
        <EmptyState
          label="No profiles yet."
          hint={
            <span>
              Run <MonoCode style={{ color: "var(--blue-text)" }}>junction profile create</MonoCode>{" "}
              to create one.
            </span>
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
          }}
        >
          <CardTitle>{profile.name}</CardTitle>
          {/* N keys active — ComingSoon (junction-keys, later increment) */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              Keys active
            </span>
            <ComingSoon />
          </div>
        </div>
      </CardHeader>

      {profile.sources.length > 0 && (
        <>
          <Separator style={{ marginBottom: "12px" }} />
          <CardContent>
            <p
              style={{
                fontSize: "var(--text-caption)",
                color: "var(--gray-700)",
                fontWeight: 500,
                marginBottom: "8px",
              }}
            >
              Routes
            </p>
            {/* Route rows — the signature element (inc 24.5) */}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {profile.sources.map((s) => (
                <RouteRow key={s.namespace} source={s} />
              ))}
            </ul>
          </CardContent>
        </>
      )}

      {profile.sources.length === 0 && (
        <>
          <Separator style={{ marginBottom: "12px" }} />
          <CardContent>
            <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
              No routes configured.
            </p>
          </CardContent>
        </>
      )}

      {/* Profile mutations — one quiet affordance (inc 24.6: was 2 pill+hint clusters per card) */}
      <Separator style={{ marginTop: "12px", marginBottom: "12px" }} />
      <CardContent>
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-600)", margin: 0 }}>
          Routes are managed via the CLI —{" "}
          <MonoCode style={{ color: "var(--blue-text)" }}>junction profile add-source</MonoCode>,{" "}
          <MonoCode style={{ color: "var(--blue-text)" }}>junction profile enable-source</MonoCode>,{" "}
          <MonoCode style={{ color: "var(--blue-text)" }}>junction profile disable-source</MonoCode>
          . Editing in the UI is coming soon.
        </p>
      </CardContent>
    </Card>
  )
}
