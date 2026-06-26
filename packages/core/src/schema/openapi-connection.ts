// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenApiConnectionSchema — generic OpenAPI/REST source descriptor.
// Data only — no parser dependency in core.
// SOURCE-AGNOSTIC: no vendor-specific fields.

import { z } from "zod"

// ---------------------------------------------------------------------------
// SpecSource — where the OpenAPI document lives
// ---------------------------------------------------------------------------

/** Where the OpenAPI specification document comes from. */
export const SpecSourceSchema = z.discriminatedUnion("from", [
  /** Fetch the spec from a URL (junction fetches it; SSRF-controlled). */
  z.object({ from: z.literal("url"), url: z.string().url() }),
  /** Read the spec from a local file path. */
  z.object({ from: z.literal("file"), path: z.string().min(1) }),
  /** Inline the spec document directly (already fetched/parsed). */
  z.object({ from: z.literal("inline"), document: z.unknown() }),
])

export type SpecSource = z.infer<typeof SpecSourceSchema>

// ---------------------------------------------------------------------------
// OpenApiAuth — how to authenticate requests to the REST API
// ---------------------------------------------------------------------------

/**
 * Authentication scheme for outbound REST API requests.
 * The secret (API key / token / password) is resolved from CredentialStore
 * at call-time and injected into the HTTP request ONLY — never stored here.
 */
export const OpenApiAuthSchema = z.discriminatedUnion("scheme", [
  /** API key injected into a header, query parameter, or cookie. */
  z.object({
    scheme: z.literal("apiKey"),
    /** Where the key is sent: header, query string, or cookie. */
    in: z.enum(["header", "query", "cookie"]),
    /** The parameter name (e.g. "X-API-Key", "api_key"). */
    name: z.string().min(1),
  }),
  /** Bearer token sent in an Authorization header. */
  z.object({
    scheme: z.literal("bearer"),
    /** HTTP header that carries the token. Default: "Authorization". */
    header: z.string().min(1).default("Authorization"),
  }),
  /** HTTP Basic auth — username is stored here; secret is the password. */
  z.object({
    scheme: z.literal("basic"),
    /** Username portion. The password is the resolved secret. */
    username: z.string().min(1),
  }),
  /** OAuth2 — treat the pre-obtained token as a bearer token. */
  z.object({ scheme: z.literal("oauth2") }),
])

export type OpenApiAuth = z.infer<typeof OpenApiAuthSchema>

// ---------------------------------------------------------------------------
// OpenApiConnectionSchema
// ---------------------------------------------------------------------------

/**
 * Generic OpenAPI/REST connection descriptor. Meaningful when Platform.kind === "openapi".
 * No vendor-specific fields — connection details are DATA, not code.
 *
 * The spec cache (dereferenced JSON) lives at ~/.junction/openapi/<platformId>.json.
 * The auth secret is resolved from CredentialStore at call-time and injected
 * into the HTTP request ONLY — it is never stored in this descriptor.
 */
export const OpenApiConnectionSchema = z.object({
  /** Where to find the OpenAPI document. */
  spec: SpecSourceSchema,
  /**
   * Base URL override for all API calls. Defaults to the spec's first server URL.
   * Operator-configured — agent args NEVER set this; only path/query/body values.
   */
  baseUrl: z.string().url().optional(),
  /** How to authenticate outbound requests. */
  auth: OpenApiAuthSchema.optional(),
  /** Extra headers added to every outbound request. */
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  /** Maximum number of operations to expose as tools. Default: 75. */
  maxTools: z.number().int().positive().optional(),
})

export type OpenApiConnection = z.infer<typeof OpenApiConnectionSchema>
