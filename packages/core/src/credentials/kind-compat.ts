// SPDX-License-Identifier: AGPL-3.0-only
// kind-compat — the single matrix mapping a Platform's declared auth shape to the
// CredentialKind(s) that make sense for it. Consumed by BOTH add paths (cli/web)
// via addCredential, which validates against it before a secret is ever touched.
//
// Back-compat: every historical credential row is kind "bearer" (the old gate).
// isKindAccepted() therefore accepts the matrix's kinds UNION {"bearer"} for every
// platform shape — "bearer" is documented legacy, universally accepted. Derivation
// (compatibleCredentialKinds' first entry) always picks the HONEST kind though —
// nothing re-labels existing data, and new adds get the real kind.
//
// oauth2 is rejected everywhere this increment (gated until inc 29's multi-ref vault).

import type { CredentialKind } from "../schema/credential.js"
import type { OpenApiAuth } from "../schema/openapi-connection.js"
import type { Platform } from "../schema/platform.js"

// ---------------------------------------------------------------------------
// OpenApiAuth-shaped matrix — shared by openapi AND graphql, which reuse the
// same auth descriptor (GraphQlConnectionSchema re-exports OpenApiAuthSchema).
// ---------------------------------------------------------------------------

function kindsForOpenApiAuth(auth: OpenApiAuth): CredentialKind[] {
  switch (auth.scheme) {
    case "bearer":
      return ["bearer"]
    case "oauth2":
      // oauth2 joins the matrix in inc 29; today the platform still only
      // accepts a bearer-shaped credential as the interim opaque token.
      return ["bearer"]
    case "apiKey":
      return ["api-key"]
    case "basic":
      // basic auth modeling is deferred (revisit-when) — the password
      // rides as an opaque bearer-kind secret in the interim.
      return ["bearer"]
    default: {
      const _: never = auth
      return _
    }
  }
}

// ---------------------------------------------------------------------------
// compatibleCredentialKinds
// ---------------------------------------------------------------------------

/**
 * Return the PREFERRED CredentialKind(s) for a platform, in derivation order —
 * the first entry is what `credential add` picks when the caller omits `--kind`.
 *
 * Exhaustive over Platform.kind and, for kinds with an auth-bearing descriptor,
 * over the descriptor's auth.scheme / transport shape. See method file 28.9 §
 * "Kind↔platform compatibility" for the source table.
 */
export function compatibleCredentialKinds(platform: Platform): CredentialKind[] {
  switch (platform.kind) {
    case "openapi": {
      const auth = platform.openapi?.auth
      return auth === undefined ? [] : kindsForOpenApiAuth(auth)
    }

    case "graphql": {
      const auth = platform.graphql?.auth
      return auth === undefined ? [] : kindsForOpenApiAuth(auth)
    }

    case "mcp": {
      const connection = platform.connection
      if (connection === undefined) return []
      if (connection.transport === "http") {
        const auth = connection.auth
        if (auth === undefined) return []
        switch (auth.scheme) {
          case "bearer":
            return ["bearer"]
          case "header":
            return ["api-key"]
          default: {
            const _: never = auth
            return _
          }
        }
      }
      if (connection.transport === "stdio") {
        // env is the honest default per the spec table; bearer stays accepted
        // for legacy rows via isKindAccepted, not as a derivation preference.
        return ["env", "bearer"]
      }
      // Exhaustiveness guard: a future third McpConnection transport must add
      // its own branch above, not silently fall through to stdio's kinds.
      const _: never = connection
      return _
    }

    case "cli":
      return ["env", "file", "bearer"]

    case "custom":
      // No connection descriptor shape defined yet for "custom" — no credential
      // kind can be safely derived or validated against.
      return []

    default: {
      const _: never = platform.kind
      return _
    }
  }
}

// ---------------------------------------------------------------------------
// isKindAccepted
// ---------------------------------------------------------------------------

/**
 * Whether `kind` is an acceptable credential kind for `platform` at add time.
 *
 * = compatibleCredentialKinds(platform) ∪ {"bearer"} (universal legacy back-compat),
 * EXCEPT "oauth2", which is always rejected this increment regardless of the
 * matrix (gated until inc 29).
 */
export function isKindAccepted(platform: Platform, kind: CredentialKind): boolean {
  if (kind === "oauth2") return false
  if (kind === "bearer") return true
  return compatibleCredentialKinds(platform).includes(kind)
}
