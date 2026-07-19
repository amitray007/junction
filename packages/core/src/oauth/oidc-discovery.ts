// SPDX-License-Identifier: AGPL-3.0-only
// OIDC discovery — pure parse/shape module (increment 45, Slice B).
//
// PURE, NO FETCH: core stays HTTP-free (docs/rules/). The actual
// `<issuer>/.well-known/openid-configuration` fetch lives in source-runtime
// (oidc-discovery-fetch.ts); this module owns only the well-known DOCUMENT's
// shape validation (Zod, at the boundary) and the pure mapping from that
// document onto a partially-filled CustomOAuthDesign.
//
// Discovery FILLS ENDPOINTS; it does NOT mint identity. `id`/`displayName`
// are left for the user to supply — an issuer URL alone doesn't imply a slug
// or a human-facing name, and minting one here would either guess badly or
// smuggle policy (slug derivation) into a "pure parse" module. Slice D's
// authoring UI merges the discovered partial with the user's own id/name
// before calling `parseCustomOAuthDesign` for the real, full validation.
//
// SECURITY: this module never touches the network and never sees a secret —
// the well-known doc is unauthenticated, public metadata. The one sensitive
// field it emits is `tokenUrl` (the eventual token-exfil surface if a design
// is saved and referenced) — Slice D's user-confirmed save is the actual
// gate; this module just shapes what discovery found.

import { err, ok, type Result } from "neverthrow"
import { z } from "zod"
import type { CustomOAuthDesign } from "./designs-store.js"

// ---------------------------------------------------------------------------
// The well-known document — only the fields junction's design shape cares
// about. `.passthrough()`-free (Zod strips unknown keys by default), so a
// provider's extra well-known fields (and there are many, per OIDC Discovery
// 1.0 §3) don't fail validation — only the fields we actually read are
// required/typed.
// ---------------------------------------------------------------------------

const OidcWellKnownSchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
})

export type OidcWellKnownDoc = z.infer<typeof OidcWellKnownSchema>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type OidcDiscoveryError =
  /** The raw doc failed Zod validation (missing/malformed authorization_endpoint, token_endpoint, or issuer). */
  { kind: "non-conforming-doc"; cause: unknown }

// ---------------------------------------------------------------------------
// discoveredDesignFromDoc
// ---------------------------------------------------------------------------

/**
 * Validate a raw `.well-known/openid-configuration` response body and map it
 * onto a PARTIAL `CustomOAuthDesign` (endpoints only — no `id`/`displayName`,
 * see header). PURE: no I/O, no throw across the boundary — a non-conforming
 * doc is a typed `Err`, not an exception.
 *
 * Mapping:
 *   - `authorizationUrl` ← `authorization_endpoint`
 *   - `tokenUrl` ← `token_endpoint`
 *   - `userinfoUrl` ← `userinfo_endpoint` (if present)
 *   - `defaultScopes` ← `scopes_supported` (if present)
 *   - `pkce` ← `DEFAULT_DISCOVERED_PKCE` (`"S256"`) unconditionally. The method
 *     file's rule ("S256 if S256 in code_challenge_methods_supported else
 *     default") collapses to a constant here because the fallback default
 *     ITSELF is `"S256"` (matching the catalog's own generic-provider default,
 *     catalog.ts) — junction never infers `"plain"` or `"disabled"` from
 *     discovery either way. A doc that omits `code_challenge_methods_supported`
 *     entirely (allowed — it's optional in the schema) still gets S256 as the
 *     SAFE default (PKCE is opt-out, not opt-in, at authoring time; the user
 *     can hand-edit if the provider truly doesn't support it, which
 *     real-world OIDC providers essentially always do).
 *
 * `issuerUrl` is accepted but currently unused in the mapping (the doc's own
 * `issuer` field is validated for presence/shape only, not cross-checked
 * against the URL discovery was fetched from — that cross-check, if wanted,
 * is a source-runtime concern since only the fetch layer knows the requested
 * issuer URL's exact normalized form).
 */
export function discoveredDesignFromDoc(
  issuerUrl: string,
  rawDoc: unknown,
): Result<Partial<CustomOAuthDesign>, OidcDiscoveryError> {
  void issuerUrl // reserved for a future issuer cross-check (see doc comment); not used in the mapping itself.

  const parsed = OidcWellKnownSchema.safeParse(rawDoc)
  if (!parsed.success) {
    return err({ kind: "non-conforming-doc", cause: parsed.error })
  }
  const doc = parsed.data

  const design: Partial<CustomOAuthDesign> = {
    authorizationUrl: doc.authorization_endpoint,
    tokenUrl: doc.token_endpoint,
    pkce: DEFAULT_DISCOVERED_PKCE,
    ...(doc.userinfo_endpoint !== undefined ? { userinfoUrl: doc.userinfo_endpoint } : {}),
    ...(doc.scopes_supported !== undefined ? { defaultScopes: doc.scopes_supported } : {}),
  }

  return ok(design)
}

/**
 * The PKCE method assigned to every discovered design (see the mapping note
 * above). Named so a future increment that wants to actually branch on
 * `code_challenge_methods_supported` (e.g. reject discovery for a provider
 * that doesn't advertise S256 at all) has one constant to change, not a
 * scattered literal.
 */
const DEFAULT_DISCOVERED_PKCE: CustomOAuthDesign["pkce"] = "S256"
