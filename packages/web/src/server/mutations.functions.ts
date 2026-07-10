// SPDX-License-Identifier: AGPL-3.0-only
// Mutation server function wrappers — POST endpoints for credential write paths.
// Routes MUST NOT import @junction/core or mutations.server.ts directly.
//
// Every handler: (1) assertLocalHost() — loopback Host check (DNS-rebinding)
// PLUS an explicit Origin allowlist (the actual CSRF control — see
// fn-guards.server.ts's assertLocalHost doc comment), and (2) validates
// input before touching core.
//
// The new secret is an INPUT only — it is NEVER echoed back in any return value.

import type { CredentialKind } from "@junction/core"
import { createServerFn } from "@tanstack/react-start"
import { assertLocalHost, requireSecretString, requireString } from "./fn-guards.server.js"
import {
  mutateAddCredential,
  mutateRemoveCredential,
  mutateRenameCredential,
  mutateRotateCredential,
  testCredential,
} from "./mutations.server.js"

// Re-export the metadata type so route files can annotate without importing
// from mutations.server.ts (which is server-only by convention).
export type {
  AddVerifyResult,
  CredentialMutationMeta,
  TestCredentialResult,
} from "./mutations.server.js"

// Non-oauth2 CredentialKind values — oauth2 stays gated until inc 29 (addCredential
// rejects it too; this validator just gives a clean 400 instead of a core error).
const ADD_CREDENTIAL_KINDS = ["api-key", "bearer", "file", "env"] as const

function requireCredentialKind(value: unknown): Exclude<CredentialKind, "oauth2"> {
  if (typeof value === "string" && (ADD_CREDENTIAL_KINDS as readonly string[]).includes(value)) {
    return value as Exclude<CredentialKind, "oauth2">
  }
  throw new Response(`Bad Request: kind must be one of ${ADD_CREDENTIAL_KINDS.join(", ")}`, {
    status: 400,
  })
}

// ---------------------------------------------------------------------------
// Server functions (POST — mutations)
// ---------------------------------------------------------------------------

export const addCredentialFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      platformId: requireString(d.platformId, "platformId"),
      account: requireString(d.account, "account"),
      kind: requireCredentialKind(d.kind),
      // requireSecretString (32.13 Slice E4) — NOT requireString: a secret's
      // leading/trailing whitespace must be preserved, not silently trimmed.
      secret: requireSecretString(d.secret, "secret"),
      verify: d.verify === true,
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateAddCredential(data)
  })

export const rotateCredentialFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      credentialId: requireString(d.credentialId, "credentialId"),
      // requireSecretString (32.13 Slice E4) — see addCredentialFn's comment.
      newSecret: requireSecretString(d.newSecret, "newSecret"),
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateRotateCredential(data)
  })

export const removeCredentialFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      credentialId: requireString(d.credentialId, "credentialId"),
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateRemoveCredential(data.credentialId)
  })

// Rename — edit the account LABEL in place (Task 5). The only in-place metadata
// edit; the secret stays rotate-only, client_id is a reconnect concern.
export const renameCredentialFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      credentialId: requireString(d.credentialId, "credentialId"),
      account: requireString(d.account, "account"),
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateRenameCredential(data)
  })

// Test Connection (28.9) — re-verify an existing credential on demand (the row
// ⋯ menu action). Distinct from addCredentialFn's opt-in `verify` — this runs
// against an already-stored credential, resolving its secret from the store.
export const testCredentialFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      credentialId: requireString(d.credentialId, "credentialId"),
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return testCredential(data.credentialId)
  })
