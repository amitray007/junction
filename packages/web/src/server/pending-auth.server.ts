// SPDX-License-Identifier: AGPL-3.0-only
// Pending-auth state singleton (increment 29, slice C) — the in-memory
// `state -> {codeVerifier, ...}` Map shared between the connect server-fn
// (oauth-connect.server.ts's startConnect/startReconnect, which PUTS an entry)
// and the /oauth/callback loader (which TAKES it). Both import THIS module,
// so they share the ONE Map living in the serve process — same-process,
// single-user, correct (method file F8 caveat; mirrors inc-27's session-map
// discipline).
//
// `state` IS the CSRF guard for the callback (a top-level browser nav, not a
// guarded server-fn) — takePending is get-and-delete so a state is consumed
// EXACTLY once: a replayed/retried callback request finds nothing and errors
// cleanly instead of re-persisting.
//
// SECURITY: this Map holds a codeVerifier + (for BYO client re-entry) a
// clientSecret in memory for the few minutes a connect is in flight. It is
// NEVER exported, NEVER returned from a server-fn/loader, and this module is
// server-only (imported only from *.server.ts / *.functions.ts handlers).

export interface PendingAuth {
  codeVerifier: string | null
  providerId: string
  clientId: string
  clientSecret: string
  scopes: string[]
  createdAt: number
  /** Create a new credential, or reconnect (repoint) an existing one. */
  intent:
    | { mode: "create"; platformId: string; account: string }
    | { mode: "update"; credentialId: string }
}

// TTL + cap mirror the inc-27 session-map discipline: an abandoned connect
// (tab closed mid-consent, provider never redirects back) must not leak
// forever, and a burst of abandoned connects must not grow the Map unbounded.
const TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_ENTRIES = 100

const pending = new Map<string, PendingAuth>()

/** Remove entries older than TTL_MS. Called on every put so the Map self-cleans. */
function sweepExpired(now: number): void {
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) pending.delete(state)
  }
}

/**
 * Stash a pending connect flow keyed by `state`. Sweeps expired entries first;
 * if still at MAX_ENTRIES after the sweep, evicts the OLDEST entry (insertion
 * order — Map preserves it) before inserting, so the Map never grows past cap
 * even under a sustained burst of abandoned connects.
 */
export function putPending(state: string, entry: PendingAuth): void {
  sweepExpired(entry.createdAt)
  if (pending.size >= MAX_ENTRIES) {
    const oldest = pending.keys().next()
    if (!oldest.done) pending.delete(oldest.value)
  }
  pending.set(state, entry)
}

/**
 * Get-and-delete: single-use. A miss (unknown state, already-consumed state,
 * or a state that expired past TTL) returns undefined — the caller (the
 * callback loader) treats that as the CSRF/replay rejection.
 */
export function takePending(state: string): PendingAuth | undefined {
  const entry = pending.get(state)
  if (entry === undefined) return undefined
  pending.delete(state)
  if (Date.now() - entry.createdAt > TTL_MS) return undefined
  return entry
}

// Test-only escape hatch — no other module may reach into `pending` directly.
/**
 * @internal test-only
 * @public Used by pending-auth.server.test.ts and oauth-connect.server.test.ts
 * (both are *.test.ts, excluded from knip's project scan by knip.jsonc's
 * `ignore: ["**\/*.test.ts"]` — a detection gap, not dead code).
 */
export function _clearPendingForTests(): void {
  pending.clear()
}

/**
 * @internal test-only
 * @public Used by pending-auth.server.test.ts and oauth-connect.server.test.ts
 * (both are *.test.ts, excluded from knip's project scan by knip.jsonc's
 * `ignore: ["**\/*.test.ts"]` — a detection gap, not dead code).
 */
export function _pendingSizeForTests(): number {
  return pending.size
}
