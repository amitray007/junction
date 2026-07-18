// SPDX-License-Identifier: AGPL-3.0-only
// Server-only OAuth-design mutation helpers — add/delete a CUSTOM design, and
// OIDC discovery (increment 45, Slice D). Called exclusively from
// oauth-design-mutations.functions.ts createServerFn handlers.
// SECURITY: metadata-only output — a design carries no client secret (those
// are per-credential, entered at connect time); the tokenUrl IS shown (it's
// the field the user must confirm before save — see the method file's D2).

import type { CustomOAuthDesign, DesignOpError } from "@junction/core"
import { addCustomDesign, createRepositories, deleteCustomDesign, getPaths } from "@junction/core"
import { fetchOidcDiscovery, type OidcDiscoveryFetchError } from "@junction/source-runtime"
import { getDb } from "./shared.server.js"

/**
 * SECURITY (credential-security review, inc 45): the tokenUrl is where refresh
 * tokens are POSTed — the exfil surface. The create-design request must ECHO
 * the exact tokenUrl the human confirmed (mirroring the CLI's
 * `--confirm-token-url`), enforced at the server-fn trust boundary — NOT only
 * in the React form's state, else a local agent POSTing directly to the
 * server-fn could create a design pointing tokenUrl at an attacker endpoint
 * with no human confirmation. Throws a 400 `Response` on absence/mismatch.
 *
 * Lives here (a `.server.ts`, server-only + testable) rather than the
 * `.functions.ts` validator, because exporting a symbol from `.functions.ts`
 * (which the client route tree imports) pulls `fn-guards.server` into the
 * client bundle — the validator calls this but stays free of exports itself.
 */
export function assertTokenUrlConfirmed(confirmedTokenUrl: unknown, tokenUrl: string): void {
  if (typeof confirmedTokenUrl !== "string" || confirmedTokenUrl !== tokenUrl) {
    throw new Response(
      "Bad Request: confirmedTokenUrl must match tokenUrl — the token URL (where refresh tokens are sent) must be explicitly confirmed",
      { status: 400 },
    )
  }
}

// ---------------------------------------------------------------------------
// Error → human-readable message
// ---------------------------------------------------------------------------

/**
 * Map a DesignOpError to a human-readable message + (for "invalid-design")
 * a field-level breakdown, mirroring platform-mutations.server.ts's
 * zodIssuesToFieldErrors pattern — the create form needs a field-anchored
 * error, not a single string, so a bad slug reads as an inline Field error
 * rather than a generic toast (the inc-43 credentialNameError lesson this
 * method file calls out explicitly).
 */
function designOpErrorMessage(e: DesignOpError): string {
  switch (e.kind) {
    case "invalid-design":
      return "This design doesn't validate — check the id, URLs, and required fields."
    case "builtin-collision":
      return `"${e.id}" is a built-in Junction design id and can't be used for a custom design.`
    case "already-exists":
      return `A custom design with id "${e.id}" already exists.`
    case "not-custom":
      return `"${e.id}" is a built-in design — only custom designs can be deleted.`
    case "not-found":
      return `No custom design with id "${e.id}" exists.`
    case "referenced": {
      const parts: string[] = []
      if (e.platformIds.length > 0) parts.push(`platform(s) ${e.platformIds.join(", ")}`)
      if (e.credentialIds.length > 0) parts.push(`credential(s) ${e.credentialIds.join(", ")}`)
      return `"${e.id}" is still referenced by ${parts.join(" and ")} — unlink those first.`
    }
    case "store-error":
      return "The custom designs store is unavailable or corrupt — see server logs."
    default: {
      const _: never = e
      return _
    }
  }
}

// ---------------------------------------------------------------------------
// addCustomDesignFn's server-side handler
// ---------------------------------------------------------------------------

export type AddCustomDesignResult =
  | { ok: true; design: CustomOAuthDesign }
  | { ok: false; error: string }

export async function mutateAddCustomDesign(input: unknown): Promise<AddCustomDesignResult> {
  const result = await addCustomDesign(getPaths(), input)
  if (result.isErr()) return { ok: false, error: designOpErrorMessage(result.error) }
  return { ok: true, design: result.value }
}

// ---------------------------------------------------------------------------
// deleteCustomDesignFn's server-side handler
// ---------------------------------------------------------------------------

export type DeleteCustomDesignResult = { ok: true } | { ok: false; error: string }

export async function mutateDeleteCustomDesign(id: string): Promise<DeleteCustomDesignResult> {
  const db = await getDb()
  if (db === null) return { ok: false, error: "Database unavailable" }
  const repos = createRepositories(db)

  const result = await deleteCustomDesign(getPaths(), repos, id)
  if (result.isErr()) return { ok: false, error: designOpErrorMessage(result.error) }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// discoverOidcFn's server-side handler
// ---------------------------------------------------------------------------

export type DiscoverOidcResult =
  | { ok: true; design: Partial<CustomOAuthDesign> }
  | { ok: false; error: string }

function discoveryErrorMessage(e: OidcDiscoveryFetchError): string {
  switch (e.kind) {
    case "unreachable":
      return `Couldn't reach the issuer (${e.detail}). Check the URL.`
    case "non-2xx":
      return `The issuer responded with HTTP ${e.status} — no discovery document at that URL.`
    case "malformed-json":
      return "The issuer's discovery document isn't valid JSON."
    case "non-conforming-doc":
      return "The issuer's discovery document is missing required fields (authorization_endpoint/token_endpoint)."
    default: {
      const _: never = e
      return _
    }
  }
}

/**
 * Discover an issuer's OAuth endpoints via its `.well-known/openid-configuration`
 * document, for the authoring form's "From an issuer URL" mode to pre-fill.
 * SECURITY: `issuerUrl` must come from the user TYPING it into the form — this
 * handler does not (cannot) verify provenance; the caller (the form) is
 * responsible for never invoking this with a value sourced from observed
 * content. Returns a PARTIAL design (endpoints only, no id/displayName) —
 * the user still supplies + confirms those, and confirms the tokenUrl before
 * any save (the exfil-surface gate).
 */
export async function discoverOidc(issuerUrl: string): Promise<DiscoverOidcResult> {
  const result = await fetchOidcDiscovery(issuerUrl)
  if (result.isErr()) return { ok: false, error: discoveryErrorMessage(result.error) }
  return { ok: true, design: result.value }
}
