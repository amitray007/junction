// SPDX-License-Identifier: AGPL-3.0-only
// base-url.ts — resolve the absolute base URL for an OpenAPI spec at add-time.
// Pure: no I/O, no fs, no fetch. Called by `platform add` to validate + store
// an absolute baseUrl before persisting the platform.
// SOURCE-AGNOSTIC: no vendor-specific logic.

import { err, ok, type Result } from "neverthrow"

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Typed errors from resolveSpecBaseUrl.
 * - no-base-url: spec has no usable servers entry and no --base-url was supplied.
 * - invalid-base-url: the URL (override or spec) is not a parseable absolute http(s) URL.
 * - base-url-has-variables: the spec's server URL uses server-variable templates ({var})
 *   that we do not substitute; caller must supply --base-url.
 */
export type SpecBaseUrlError =
  | { kind: "no-base-url" }
  | { kind: "invalid-base-url" }
  | { kind: "base-url-has-variables" }

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

/** Returns true if url starts with http:// or https:// (case-insensitive). */
function isAbsoluteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Strip trailing slash and validate the URL is parseable. */
function normalize(url: string): Result<string, SpecBaseUrlError> {
  const stripped = url.replace(/\/$/, "")
  try {
    new URL(stripped)
    return ok(stripped)
  } catch {
    return err({ kind: "invalid-base-url" })
  }
}

// ---------------------------------------------------------------------------
// resolveSpecBaseUrl
// ---------------------------------------------------------------------------

/**
 * Determine the absolute base URL for an OpenAPI spec at platform-add time.
 *
 * Resolution order:
 * 1. `override` (--base-url): validated to be an absolute http(s) URL.
 * 2. `schema.servers[0].url`:
 *    - Absolute http(s) → accepted as-is.
 *    - Relative (no scheme) → resolved against `specSourceUrl` (the spec's fetch URL).
 *    - Contains `{` (server-variable template) → `base-url-has-variables`.
 *    - Missing / empty / non-string → `no-base-url`.
 *
 * Trailing slashes are stripped from the result. The returned URL is always
 * absolute, satisfying `OpenApiConnectionSchema.baseUrl = z.string().url()`.
 *
 * This is the add-time counterpart to `http.ts:resolveBaseUrl`, which handles
 * the runtime fallback (prefers connection.baseUrl; falls back to servers[0]
 * if that is an absolute URL). The runtime path is unchanged.
 */
export function resolveSpecBaseUrl(
  schema: Record<string, unknown>,
  specSourceUrl: string,
  override?: string,
): Result<string, SpecBaseUrlError> {
  // 1. Explicit override wins (from --base-url)
  if (override !== undefined && override !== "") {
    // A templated override (e.g. https://{host}/v1) is not a concrete URL — the
    // WHATWG parser would accept "{" in the host and store a broken base URL.
    // Reject it the same way the spec-server path rejects variables.
    if (!isAbsoluteHttpUrl(override) || override.includes("{")) {
      return err({ kind: "invalid-base-url" })
    }
    return normalize(override)
  }

  // 2. servers[0].url from the spec
  const servers = schema.servers
  if (!Array.isArray(servers) || servers.length === 0) {
    return err({ kind: "no-base-url" })
  }

  const first = servers[0]
  if (first === null || first === undefined || typeof first !== "object") {
    return err({ kind: "no-base-url" })
  }

  const url = (first as Record<string, unknown>).url
  if (typeof url !== "string" || url.length === 0) {
    return err({ kind: "no-base-url" })
  }

  // Server-variable templating — not substituted; caller must pass --base-url
  if (url.includes("{")) {
    return err({ kind: "base-url-has-variables" })
  }

  // Absolute http(s) URL
  if (isAbsoluteHttpUrl(url)) {
    return normalize(url)
  }

  // Relative URL — resolve against the spec's fetch URL
  try {
    const resolved = new URL(url, specSourceUrl).toString()
    return normalize(resolved)
  } catch {
    return err({ kind: "invalid-base-url" })
  }
}
