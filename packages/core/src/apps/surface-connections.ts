// SPDX-License-Identifier: AGPL-3.0-only
// intersectSurfaces — pure surface↔connection intersection (increment 30.10).
// Given an app's catalog surfaces (by kind) and its live connections, compute
// which connections belong to which surface, and which match NO surface at
// all (the "Other connections" bucket — see docs/design/app-surface-model.md
// §7 + method file docs/methods/30.10-surface-first-app-page.md §3b).
//
// PURE, no I/O — kept out of group.ts (surfaces-blind) and NOT in group.ts's
// file so the surfaces dimension stays a separate, additive concern.

/**
 * Intersect an app's catalog surfaces against its live connections, by `kind`.
 *
 * Generic over the connection element `C` so the FULL connection object is
 * carried through (never reduced to a bare kind string) — callers need the
 * whole `ConnectionMeta` (or richer) shape to render a `ConnectionRow`.
 *
 * `leftover` = connections whose kind matches NO catalog surface. NEVER
 * dropped — this is the "Other connections" bucket (an uncatalogued/manually
 * -added platform, or an app-level kind mismatch). Every input connection
 * lands in exactly one place: a `matched[].connections` bucket, or `leftover`.
 *
 * ⚠️ LIMITATION (same-kind ambiguity, RE-DEFERRED past increment 30.12):
 * matching is by `kind` alone. If a catalog entry ever authored TWO surfaces
 * of the same kind, a connection of that kind would be ambiguous between
 * them — this function has no way to disambiguate further. 30.12 gives every
 * surface a distinct `<appId>-<kind>` platformId (multi-surface groupability
 * + multi-account), but does NOT introduce same-kind surfaces, so this
 * limitation is untouched by that work. No current catalog entry has this
 * collision (e.g. GitHub's 5 surfaces are 5 distinct kinds), so one-surface-
 * per-kind remains a safe assumption. Revisit only if/when a catalog entry
 * needs genuine same-kind surface composition (see
 * docs/futures/revisit-when.md). This is DISTINCT from multiple connections
 * (accounts) on one surface, which IS supported — `connections` is an array
 * precisely for that multi-account wedge.
 */
export function intersectSurfaces<C extends { kind: string }>(
  surfaces: { kind: string }[],
  connections: C[],
): { matched: { kind: string; connections: C[] }[]; leftover: C[] } {
  const byKind = new Map<string, C[]>()
  for (const conn of connections) {
    const bucket = byKind.get(conn.kind)
    if (bucket) bucket.push(conn)
    else byKind.set(conn.kind, [conn])
  }

  const matched = surfaces.map((surface) => {
    const bucket = byKind.get(surface.kind) ?? []
    byKind.delete(surface.kind)
    return { kind: surface.kind, connections: bucket }
  })

  // Whatever remains in byKind matched no surface — flatten it into leftover,
  // preserving the original connections' relative order isn't load-bearing
  // here (no consumer depends on cross-kind ordering), so a simple flatMap
  // over the remaining buckets is sufficient.
  const leftover = [...byKind.values()].flat()

  return { matched, leftover }
}
