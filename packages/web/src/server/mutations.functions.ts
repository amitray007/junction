// SPDX-License-Identifier: AGPL-3.0-only
// Mutation server function wrappers — POST endpoints for credential write paths.
// Routes MUST NOT import @junction/core or mutations.server.ts directly.
//
// Every handler: (1) assertLocalHost() — DNS-rebinding / CSRF guard, and
// (2) validates input before touching core.
//
// The new secret is an INPUT only — it is NEVER echoed back in any return value.

import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { isLocalHost } from "./host-guard.js"
import {
  mutateAddCredential,
  mutateRemoveCredential,
  mutateRotateCredential,
} from "./mutations.server.js"

// Re-export the metadata type so route files can annotate without importing
// from mutations.server.ts (which is server-only by convention).
export type { CredentialMutationMeta } from "./mutations.server.js"

// ---------------------------------------------------------------------------
// DNS-rebinding / CSRF guard — loopback-only (mirrors data.functions.ts)
// ---------------------------------------------------------------------------

function assertLocalHost(): void {
  if (!isLocalHost(getRequest().headers.get("host"))) {
    throw new Response("Forbidden: access restricted to localhost", { status: 403 })
  }
}

// ---------------------------------------------------------------------------
// Input validation helpers — server-side only, no Zod client bundle
// ---------------------------------------------------------------------------

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Response(`Bad Request: ${name} must be a non-empty string`, { status: 400 })
  }
  return value.trim()
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
