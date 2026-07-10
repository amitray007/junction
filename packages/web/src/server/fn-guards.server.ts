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
// DNS-rebinding guard (loopback-only) + explicit Origin allowlist (CSRF)
// ---------------------------------------------------------------------------

/**
 * True iff `origin` is absent, OR parses to a loopback host (127.0.0.1,
 * localhost, or [::1] — any port). Reused as the CSRF control below.
 *
 * HONESTY NOTE (32.13 Slice E2): a malformed/unparseable Origin string is
 * treated as a REJECT (not an accept) — fail-closed, matching isLocalHost's
 * fail-closed contract for a missing/malformed Host.
 */
function isSameOriginOrAbsent(origin: string | null): boolean {
  if (origin === null) return true
  try {
    return isLocalHost(new URL(origin).host)
  } catch {
    return false
  }
}

/**
 * Throws a 403 Response if the request Host header is not a loopback address,
 * OR if a present Origin header does not name a loopback host.
 *
 * Call at the start of every createServerFn handler body (after .validator()).
 *
 * WHAT THIS GUARDS AGAINST (corrected 32.13 Slice E2 — the prior comment here
 * and at every call site below was WRONG): the loopback-only Host check alone
 * does NOT stop CSRF. A browser sets the Host header to the REQUEST'S target
 * (127.0.0.1:4321), not the page that INITIATED the request — a malicious
 * page at evil.example.com can still fetch("http://127.0.0.1:4321/...", {
 * method: "POST" }) and the Host header will correctly read 127.0.0.1,
 * passing isLocalHost every time. The Host check's actual job is DNS-
 * rebinding defense (stopping evil.example.com from resolving to 127.0.0.1
 * and having the BROWSER treat it as same-origin) — a DIFFERENT threat.
 *
 * The Origin check here is what actually stops CSRF: a same-origin request
 * (the junction web UI itself) either omits Origin (simple GET nav / same-
 * origin no-CORS-preflight in some browsers) or sends
 * `http://127.0.0.1:<port>` / `http://localhost:<port>`. A cross-site page's
 * fetch/form-submit to this endpoint sends the ATTACKER's Origin
 * (https://evil.example.com), which fails isSameOriginOrAbsent and is
 * rejected here — BEFORE any handler logic runs.
 *
 * RESIDUAL / WHY "Origin absent -> allow" IS STILL SAFE TODAY: these
 * server-fns carry no session cookie / ambient credential (see
 * docs/futures/revisit-when.md) — a same-site simple GET (no Origin header
 * on many browsers) cannot itself mutate anything an attacker couldn't
 * already do by knowing the endpoint shape, since there's no ambient
 * auth for a forged request to RIDE. Revisit if that stops being true (the
 * triggers below).
 */
export function assertLocalHost(): void {
  const request = getRequest()
  // Defense-in-depth atop the loopback bind + serve.mjs's HTTP-layer Host check.
  // Throw a real 403 Response (not an Error → which TanStack surfaces as a 500).
  if (!isLocalHost(request.headers.get("host"))) {
    throw new Response("Forbidden: access restricted to localhost", { status: 403 })
  }
  // The actual CSRF control (32.13 Slice E2) — an explicit Origin allowlist.
  // Rejects a foreign-Origin POST even though its Host header is legitimately
  // loopback (the DNS-rebinding check above cannot catch this case).
  if (!isSameOriginOrAbsent(request.headers.get("origin"))) {
    throw new Response("Forbidden: cross-origin request rejected", { status: 403 })
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
 *
 * DO NOT use this for a SECRET field (a credential's `secret`/`newSecret`) —
 * use requireSecretString instead (32.13 Slice E4). This trims the returned
 * value, which would silently mangle a secret with intentional leading/
 * trailing whitespace before it ever reaches the credential store.
 */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Response(`Bad Request: ${name} must be a non-empty string`, { status: 400 })
  }
  return value.trim()
}

/**
 * Assert that `value` is a non-empty string — for SECRET fields ONLY (32.13
 * Slice E4). Emptiness is checked against the TRIMMED value (an all-
 * whitespace "secret" is still rejected as empty input), but the RETURNED
 * value is the ORIGINAL, untrimmed string.
 *
 * RATIONALE: requireString trims before returning, which is correct for
 * ordinary text fields (account labels, IDs) but WRONG for a secret — some
 * providers legitimately mint tokens/keys with meaningful leading or
 * trailing whitespace, and junction has no business normalizing a value it
 * never interprets, only stores opaquely via CredentialStore.set(). Silently
 * trimming would store a DIFFERENT secret than the one the user pasted,
 * with no error and no way to notice until the credential mysteriously
 * fails to authenticate.
 */
export function requireSecretString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Response(`Bad Request: ${name} must be a non-empty string`, { status: 400 })
  }
  return value
}
