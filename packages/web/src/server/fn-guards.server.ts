// SPDX-License-Identifier: AGPL-3.0-only
// Shared server-fn guards — the rule-of-three extraction (data.functions.ts was
// consumer 1, mutations.functions.ts was consumer 2, settings.functions.ts is
// consumer 3). Kept tiny: exactly two guards, nothing else.
//
// IMPORTANT: this module is server-only. It may only be imported from *.functions.ts
// handlers (inside createServerFn) or *.server.ts files. Never import in client-
// reachable modules (routes, UI components, non-server utilities).

import { getRequest } from "@tanstack/react-start/server"
import { isLocalHost } from "./host-guard.js"

// ---------------------------------------------------------------------------
// DNS-rebinding / CSRF guard — loopback-only
// ---------------------------------------------------------------------------

/**
 * Throws a 403 Response if the request Host header is not a loopback address.
 * Call at the start of every createServerFn handler body (after .validator()).
 */
export function assertLocalHost(): void {
  // Defense-in-depth atop the loopback bind + serve.mjs's HTTP-layer Host check.
  // Throw a real 403 Response (not an Error → which TanStack surfaces as a 500).
  if (!isLocalHost(getRequest().headers.get("host"))) {
    throw new Response("Forbidden: access restricted to localhost", { status: 403 })
  }
}

// ---------------------------------------------------------------------------
// Input validation helper — pure, no state, no core import
// ---------------------------------------------------------------------------

/**
 * Assert that `value` is a non-empty string, trimmed.
 * Throws a 400 Response if the assertion fails (surfaces cleanly to TanStack Start).
 *
 * NOTE: validators run BEFORE assertLocalHost() in the createServerFn call sequence.
 * Keep validators pure (typeof + trim only, no I/O, no core) so this ordering is safe.
 */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Response(`Bad Request: ${name} must be a non-empty string`, { status: 400 })
  }
  return value.trim()
}
