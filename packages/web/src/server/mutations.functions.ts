// SPDX-License-Identifier: AGPL-3.0-only
// Mutation server function wrappers — POST endpoints for credential write paths.
// Routes MUST NOT import @junction/core or mutations.server.ts directly.
//
// Every handler: (1) assertLocalHost() — DNS-rebinding / CSRF guard, and
// (2) validates input before touching core.
//
// The new secret is an INPUT only — it is NEVER echoed back in any return value.

import { createServerFn } from "@tanstack/react-start"
import { assertLocalHost, requireString } from "./fn-guards.server.js"
import {
  mutateAddCredential,
  mutateRemoveCredential,
  mutateRotateCredential,
} from "./mutations.server.js"

// Re-export the metadata type so route files can annotate without importing
// from mutations.server.ts (which is server-only by convention).
export type { CredentialMutationMeta } from "./mutations.server.js"

// ---------------------------------------------------------------------------
// Server functions (POST — mutations)
// ---------------------------------------------------------------------------

export const addCredentialFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      platformId: requireString(d.platformId, "platformId"),
      account: requireString(d.account, "account"),
      kind: "bearer" as const,
      secret: requireString(d.secret, "secret"),
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
      newSecret: requireString(d.newSecret, "newSecret"),
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
