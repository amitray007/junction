// SPDX-License-Identifier: AGPL-3.0-only
// OIDC discovery — the fetch half (increment 45, Slice B). core stays
// HTTP-free (docs/rules/); this module owns the ONE network call
// (`<issuer>/.well-known/openid-configuration`, GET, unauthenticated) and
// hands the raw JSON to core's discoveredDesignFromDoc for validation/shape.
//
// SECURITY:
//   - The fetch targets ONLY the issuer URL the CALLER passes. That URL must
//     originate from the user typing it into the authoring UI/CLI — never
//     from observed content (a scraped page, an agent-fed string, etc). This
//     module does not enforce that provenance (it can't — a string is a
//     string); the caller (Slice D's authoring op) is responsible for only
//     ever invoking this with a user-supplied issuer.
//   - No credential/secret is sent — OIDC discovery is unauthenticated by
//     design (it's how a client learns WHERE to send a token, before it has
//     one).
//   - The discovered `tokenUrl` is the eventual exfil surface if the
//     resulting design is saved and a platform is bound to it — but saving is
//     Slice D's user-confirmed op; this function only returns what discovery
//     found, it never persists anything.
//   - Mirrors verify-credential.ts's fetch discipline: bounded timeout (never
//     hang the caller on a slow/dead issuer), a leak-safe error `detail`
//     (constructor name / HTTP status only — never a message that could echo
//     the URL or response body), and NEVER throws across the ResultAsync
//     boundary.

import type { OidcDiscoveryError as CoreOidcDiscoveryError } from "@junction/core"
import {
  type CustomOAuthDesign,
  discoveredDesignFromDoc,
  err,
  ok,
  ResultAsync,
} from "@junction/core"

/** Max wait for the well-known fetch — mirrors verify-credential's USERINFO_TIMEOUT_MS. */
const DISCOVERY_TIMEOUT_MS = 10_000

export type OidcDiscoveryFetchError =
  /** Network failure or timeout — never reached the server, or it never responded. */
  | { kind: "unreachable"; detail: string }
  /** The server responded, but not with a 2xx (e.g. 404 — no discovery doc at this issuer). */
  | { kind: "non-2xx"; status: number }
  /** The response body wasn't parseable JSON. */
  | { kind: "malformed-json" }
  /** The parsed JSON didn't conform to the well-known doc shape (core's typed error, passed through). */
  | { kind: "non-conforming-doc"; cause: CoreOidcDiscoveryError }

/**
 * Normalize an issuer URL to its well-known discovery URL, per OIDC Discovery
 * 1.0 §4: strip any trailing slash from the issuer before appending
 * `/.well-known/openid-configuration`, so `https://acme.example.com` and
 * `https://acme.example.com/` both resolve to the SAME well-known URL.
 */
function wellKnownUrl(issuerUrl: string): string {
  const trimmed = issuerUrl.endsWith("/") ? issuerUrl.slice(0, -1) : issuerUrl
  return `${trimmed}/.well-known/openid-configuration`
}

/**
 * Fetch and validate the OIDC well-known discovery document at `issuerUrl`,
 * returning a partially-filled `CustomOAuthDesign` (endpoints only — see
 * core's discoveredDesignFromDoc doc comment) for the caller to present to
 * the user for confirmation before any save (Slice D). NEVER throws across
 * the boundary; every failure mode is a typed `OidcDiscoveryFetchError`.
 */
export function fetchOidcDiscovery(
  issuerUrl: string,
): ResultAsync<Partial<CustomOAuthDesign>, OidcDiscoveryFetchError> {
  return ResultAsync.fromPromise(doFetch(issuerUrl), toFetchError).andThen((rawDoc) => {
    const shaped = discoveredDesignFromDoc(issuerUrl, rawDoc)
    if (shaped.isErr()) {
      return err<Partial<CustomOAuthDesign>, OidcDiscoveryFetchError>({
        kind: "non-conforming-doc",
        cause: shaped.error,
      })
    }
    return ok<Partial<CustomOAuthDesign>, OidcDiscoveryFetchError>(shaped.value)
  })
}

/** Marker so `toFetchError` can distinguish a non-2xx/malformed-json rejection from a real network failure. */
class DiscoveryHttpError extends Error {
  constructor(readonly detail: { kind: "non-2xx"; status: number } | { kind: "malformed-json" }) {
    super("oidc discovery: http/parse failure")
  }
}

async function doFetch(issuerUrl: string): Promise<unknown> {
  const url = wellKnownUrl(issuerUrl)

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    // Bound the wait — a slow/hanging issuer must not stall the authoring UI
    // indefinitely. On timeout, fetch rejects with an AbortError, caught by
    // ResultAsync.fromPromise's error mapper below → unreachable.
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })

  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel()
    throw new DiscoveryHttpError({ kind: "non-2xx", status: response.status })
  }

  try {
    return (await response.json()) as unknown
  } catch {
    throw new DiscoveryHttpError({ kind: "malformed-json" })
  }
}

function toFetchError(cause: unknown): OidcDiscoveryFetchError {
  if (cause instanceof DiscoveryHttpError) return cause.detail
  // Network-level failure / timeout / DNS / TLS — never surface `.message`
  // (could echo the URL); the constructor name is a leak-safe label, mirrors
  // verify-credential.ts's verifyOAuthToken catch.
  return {
    kind: "unreachable",
    detail: cause instanceof Error ? cause.constructor.name : "fetch-failed",
  }
}
