// SPDX-License-Identifier: AGPL-3.0-only
// OAuth-design mutation server function wrappers — POST endpoints for the
// custom-design authoring surface (increment 45, Slice D). Routes MUST NOT
// import @junction/core or oauth-design-mutations.server.ts directly.
//
// Every handler: assertLocalHost() (loopback Host + Origin allowlist — see
// fn-guards.server.ts), then validates input before touching core.

import { createServerFn } from "@tanstack/react-start"
import {
  assertLocalHost,
  optionalString,
  optionalStringArray,
  optionalStringRecord,
  requireSingleStringField,
  requireString,
} from "./fn-guards.server.js"
import {
  assertTokenUrlConfirmed,
  discoverOidc,
  mutateAddCustomDesign,
  mutateDeleteCustomDesign,
} from "./oauth-design-mutations.server.js"

// Re-export result types so route/component files can annotate without a
// direct import from oauth-design-mutations.server.ts (server-only by convention).
export type {
  AddCustomDesignResult,
  DeleteCustomDesignResult,
  DiscoverOidcResult,
} from "./oauth-design-mutations.server.js"

// ---------------------------------------------------------------------------
// Validators — pure, no I/O, no core. The real authority is
// CustomOAuthDesignSchema (core), re-validated inside addCustomDesign; these
// are boundary pre-checks that give a clean 400 for a badly-shaped request
// body rather than a core-internal parse error.
// ---------------------------------------------------------------------------

const PKCE_VALUES = new Set(["S256", "plain", "disabled"])
const EXPIRY_STRATEGY_VALUES = new Set(["expires_in", "expires_at", "none"])
const REDIRECT_MODE_VALUES = new Set(["loopback-fixed", "loopback-ephemeral"])
const SCOPE_SEPARATOR_VALUES = new Set([" ", ",", "+"])

/**
 * Validate the create-design request body into the shape core's
 * `CustomOAuthDesignSchema` expects. Left permissive on the enum-shaped
 * fields (falls through to core's authoritative Zod parse on a bad value —
 * addCustomDesign's "invalid-design" error is what the UI actually surfaces)
 * except where a clean 400 is cheap to give here.
 */
function validateAddCustomDesignInput(raw: unknown): unknown {
  const d = raw as Record<string, unknown>
  const registrationHintRaw = d.registrationHint as Record<string, unknown> | undefined
  const tokenUrl = requireString(d.tokenUrl, "tokenUrl")
  // SECURITY (credential-security review, inc 45): the tokenUrl is where refresh
  // tokens are POSTed — the exfil surface. The confirmation MUST be enforced at
  // the trust boundary (mirroring the CLI's `--confirm-token-url`), NOT only in
  // the React form's state — else a local agent/tool POSTing directly to this
  // server-fn could create a design pointing tokenUrl at an attacker endpoint
  // with no human ever confirming it. Require the client to echo the exact
  // tokenUrl it confirmed; reject a mismatch/absence with a 400. (The check
  // itself lives in the exported, testable `assertTokenUrlConfirmed` in the
  // .server.ts sibling — this file stays free of exported symbols so the
  // client route bundle can't pull `fn-guards.server` in via a used export.)
  assertTokenUrlConfirmed(d.confirmedTokenUrl, tokenUrl)
  return {
    id: requireString(d.id, "id"),
    displayName: requireString(d.displayName, "displayName"),
    authorizationUrl: requireString(d.authorizationUrl, "authorizationUrl"),
    tokenUrl,
    scopeSeparator: SCOPE_SEPARATOR_VALUES.has(d.scopeSeparator as string) ? d.scopeSeparator : " ",
    pkce: PKCE_VALUES.has(d.pkce as string) ? d.pkce : "S256",
    supportsRefresh: d.supportsRefresh === true,
    expiryStrategy: EXPIRY_STRATEGY_VALUES.has(d.expiryStrategy as string)
      ? d.expiryStrategy
      : "expires_in",
    redirectMode: REDIRECT_MODE_VALUES.has(d.redirectMode as string)
      ? d.redirectMode
      : "loopback-fixed",
    defaultScopes: optionalStringArray(d.defaultScopes),
    authorizationParams: optionalStringRecord(d.authorizationParams),
    userinfoUrl: optionalString(d.userinfoUrl),
    registrationHint: {
      redirectUri:
        typeof registrationHintRaw?.redirectUri === "string" ? registrationHintRaw.redirectUri : "",
      scopes: typeof registrationHintRaw?.scopes === "string" ? registrationHintRaw.scopes : "",
      docsUrl: typeof registrationHintRaw?.docsUrl === "string" ? registrationHintRaw.docsUrl : "",
    },
  }
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

export const addCustomDesignFn = createServerFn({ method: "POST" })
  .validator(validateAddCustomDesignInput)
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateAddCustomDesign(data)
  })

export const deleteCustomDesignFn = createServerFn({ method: "POST" })
  .validator(requireSingleStringField("id"))
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateDeleteCustomDesign(data.id)
  })

/**
 * OIDC discovery (Slice B's fetch, wrapped) — SECURITY: `issuerUrl` must be
 * text the user typed into the form. This server-fn boundary can't verify
 * provenance (a string is a string); the client component is responsible for
 * only ever calling this with a user-supplied value, never one sourced from
 * observed/fetched content.
 */
export const discoverOidcFn = createServerFn({ method: "POST" })
  .validator(requireSingleStringField("issuerUrl"))
  .handler(async ({ data }) => {
    assertLocalHost()
    return discoverOidc(data.issuerUrl)
  })
