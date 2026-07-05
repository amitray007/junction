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
// oauth2 is no longer rejected everywhere (inc 29 — the OAuth vault): the matrix
// is honest about it (an oauth2-scheme platform's compatibleCredentialKinds
// includes "oauth2"), so a platform can declare it and the web picker can offer
// it. It still never flows through the plaintext addCredential path — OAuth
// tokens are minted via a separate connect/addOAuthCredential entry path (see
// the Exclude<CredentialKind,"oauth2"> comment in add-credential.ts).

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
      // oauth2 is the honest kind for an oauth2-scheme platform (inc 29).
      return ["oauth2"]
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

    case "http": {
      // HttpConnection reuses OpenApiAuthSchema verbatim (see http-connection.ts) —
      // same auth-shaped matrix as openapi/graphql.
      const auth = platform.http?.auth
      return auth === undefined ? [] : kindsForOpenApiAuth(auth)
    }

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
 * = compatibleCredentialKinds(platform) ∪ {"bearer"} (universal legacy back-compat).
 * oauth2 flows through the normal matrix path — accepted iff the platform's
 * compatibleCredentialKinds includes it (inc 29; see the file header comment).
 */
export function isKindAccepted(platform: Platform, kind: CredentialKind): boolean {
  if (kind === "bearer") return true
  return compatibleCredentialKinds(platform).includes(kind)
}
