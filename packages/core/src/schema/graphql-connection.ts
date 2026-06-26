// SPDX-License-Identifier: AGPL-3.0-only
// GraphQlConnectionSchema — generic GraphQL source descriptor.
// Data only — no parser dependency in core.
// SOURCE-AGNOSTIC: no vendor-specific fields.

import { z } from "zod"

import { OpenApiAuthSchema } from "./openapi-connection.js"

// Re-export so callers can import auth schema from here too.
export { OpenApiAuthSchema }

// ---------------------------------------------------------------------------
// GraphQlConnectionSchema
// ---------------------------------------------------------------------------

/**
 * Generic GraphQL connection descriptor. Meaningful when Platform.kind === "graphql".
 * No vendor-specific fields — connection details are DATA, not code.
 *
 * The auth secret is resolved from CredentialStore at call-time and injected
 * into the HTTP request ONLY — it is never stored in this descriptor.
 *
 * `schemaSdl` is cached at `platform add` time (introspect → SDL) so that
 * `graphql_schema` can serve it fast without a round-trip. Absent = live
 * introspect on demand (or a clear message if the endpoint disables it).
 */
export const GraphQlConnectionSchema = z.object({
  /** GraphQL endpoint URL (single pinned endpoint — no path substitution). */
  endpoint: z.string().url(),
  /** How to authenticate outbound requests. Reuses the OpenAPI auth model (same HTTP POST). */
  auth: OpenApiAuthSchema.optional(),
  /** Extra headers added to every outbound request. */
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  /**
   * Cached introspected schema as SDL string, written at `platform add` time.
   * `graphql_schema` serves this directly; falls back to live introspection when absent.
   */
  schemaSdl: z.string().optional(),
  /**
   * Maximum bytes allowed for a query document before sending.
   * Default: 100 000 bytes. Rejects pathological documents early.
   */
  maxQueryBytes: z.number().int().positive().optional(),
})

export type GraphQlConnection = z.infer<typeof GraphQlConnectionSchema>
