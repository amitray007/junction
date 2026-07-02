// SPDX-License-Identifier: AGPL-3.0-only
// API-key mutation server function wrappers — POST endpoints for junction's own
// auth-key mint/revoke. Routes MUST NOT import @junction/core or
// keys-mutations.server.ts directly.
//
// Every handler: (1) PURE validator — dedupes the profile-id list (a trust
// boundary regardless of the web picker UI — §2.6/§1 of the method file), then
// (2) assertLocalHost() — DNS-rebinding / CSRF guard — then the thin server helper.
//
// The mint response is the ONE exception to metadata-only across this whole app:
// it carries the plaintext key exactly once. It must never be re-fetchable.

import { createServerFn } from "@tanstack/react-start"
import { assertLocalHost, requireString } from "./fn-guards.server.js"
import {
  countKeysReferencingProfile,
  mutateDeleteKey,
  mutateMintKey,
  mutateRevokeKey,
  readApiKeys,
} from "./keys-mutations.server.js"

// Re-export the metadata type so route files can annotate without importing
// from keys-mutations.server.ts (which is server-only by convention).
export type { ApiKeyMeta, MintKeyResult } from "./keys-mutations.server.js"

// ---------------------------------------------------------------------------
// Read (GET) — metadata-only list, for the /keys table loader.
// ---------------------------------------------------------------------------

export const getApiKeys = createServerFn({ method: "GET" }).handler(async () => {
  assertLocalHost()
  return readApiKeys()
})

// ---------------------------------------------------------------------------
// Mint (POST)
// ---------------------------------------------------------------------------

type MintScope = "profile" | "profiles" | "global"

/**
 * Resolve the ApiKeyScope kind from a distinct profile-id count, per §1 of the
 * method file: scope kind is STORED, not derived from live count — but at MINT
 * time, the kind IS derived from the (deduped) selection the user made.
 *   - isGlobal → 'global' (regardless of profile count, incl. 0)
 *   - else 0 or 1 distinct id → 'profile' is invalid (must have ≥1); exactly 1 → 'profile'
 *   - else ≥2 distinct ids → 'profiles'
 */
function resolveScopeKind(isGlobal: boolean, distinctProfileIds: string[]): MintScope {
  if (isGlobal) return "global"
  return distinctProfileIds.length >= 2 ? "profiles" : "profile"
}

export const mintKeyFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    const label = requireString(d.label, "label")
    const isGlobal = d.isGlobal === true

    // profileIds: optional array of strings — validate TYPE only (pure, no I/O).
    const rawProfileIds = Array.isArray(d.profileIds) ? d.profileIds : []
    if (rawProfileIds.some((id) => typeof id !== "string")) {
      throw new Response("Bad Request: profileIds must be an array of strings", { status: 400 })
    }
    // Dedupe by id — a trust boundary regardless of the picker UI (§1: "Scope
    // counting dedupes first"). The distinct count decides profile vs profiles.
    const distinctProfileIds = Array.from(new Set(rawProfileIds as string[]))

    if (!isGlobal && distinctProfileIds.length === 0) {
      throw new Response("Bad Request: select at least one profile, or choose Global scope", {
        status: 400,
      })
    }

    const scope = resolveScopeKind(isGlobal, distinctProfileIds)
    // A global key carries NO join rows (scope is resolved live from all profiles
    // at serve time). Force [] even if a crafted POST supplied profileIds — else
    // orphan api_key_profiles rows would attach to a 'global' key (never served,
    // but a silent data inconsistency + audit noise). The UI already sends [].
    return { label, scope, profileIds: isGlobal ? [] : distinctProfileIds }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateMintKey(data)
  })

// ---------------------------------------------------------------------------
// keyId-only POST mutations (revoke / delete). NOTE: the server-only mutate fns
// MUST be referenced INSIDE .handler() (never passed in from module scope) —
// createServerFn only strips the handler body from the client bundle, so a
// top-level reference would drag keys-mutations.server.ts into the client graph
// (import-protection failure). A shared pure validator is the safe dedup.
// ---------------------------------------------------------------------------

const keyIdValidator = (raw: unknown) => {
  const d = raw as Record<string, unknown>
  return { keyId: requireString(d.keyId, "keyId") }
}

// Revoke — idempotent; the web UI only ever sends a bare keyid.
export const revokeKeyFn = createServerFn({ method: "POST" })
  .validator(keyIdValidator)
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateRevokeKey(data.keyId)
  })

// Delete — hard-remove a REVOKED key. The core op rejects active keys.
export const deleteKeyFn = createServerFn({ method: "POST" })
  .validator(keyIdValidator)
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateDeleteKey(data.keyId)
  })

// ---------------------------------------------------------------------------
// Count keys referencing a profile (GET) — the delete-profile confirm warning.
// ---------------------------------------------------------------------------

export const countKeysReferencingProfileFn = createServerFn({ method: "GET" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return { profileId: requireString(d.profileId, "profileId") }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    const count = await countKeysReferencingProfile(data.profileId)
    return { count }
  })
