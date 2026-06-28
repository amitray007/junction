// SPDX-License-Identifier: AGPL-3.0-only
// Shared server-only singletons: memoized DB connection.
// CRITICAL: this server is long-running unlike the one-shot CLI. Calling
// getDatabase() per-request leaks connections and re-runs migrations each time.
// This module holds the single process-lifetime cache keyed by JUNCTION_HOME.
// Imported by data.server.ts and mutations.server.ts — never by client modules.

import { type Db, getDatabase, getPaths } from "@junction/core"

// Keyed by home path: prod has one fixed JUNCTION_HOME → one cached connection
// reused for the server's lifetime; keying (rather than a single global) also
// keeps per-home test isolation correct and reconnects if the home ever changes.
const dbCache = new Map<string, Promise<Db | null>>()

/**
 * Returns the memoized database connection for the current JUNCTION_HOME.
 * On first call: opens the connection and runs migrations (once).
 * On failure: clears the memo so the next request can retry.
 * Returns null if the DB cannot be opened (callers return a safe fallback).
 */
export function getDb(): Promise<Db | null> {
  const { home } = getPaths()
  const existing = dbCache.get(home)
  if (existing) return existing
  // async IIFE → a real Promise<Db|null> (neverthrow's ResultAsync.then is PromiseLike<unknown>;
  // await the ResultAsync to a Result instead).
  const created = (async (): Promise<Db | null> => {
    const r = await getDatabase(getPaths())
    if (r.isErr()) {
      dbCache.delete(home) // allow retry on a later request
      return null
    }
    return r.value
  })()
  dbCache.set(home, created)
  return created
}
