// SPDX-License-Identifier: AGPL-3.0-only
// PlatformOrchestrationError — discriminated union covering every failure the
// extracted platform-add/refresh logic can produce. Carries enough data for
// callers (cli, web) to reconstruct the exact user-facing messages the CLI
// used to build inline. This is a behaviour-preserving extraction: kinds map
// 1:1 to the error conditions in the original packages/cli/src/commands/platform.ts.

import type { UpstreamError } from "@junction/core"
import type { TagCount } from "@junction/openapi-client"

export type PlatformOrchestrationError =
  // ---- mcp ----
  | { kind: "invalid-transport"; transport: string }
  | { kind: "missing-field"; field: string; context: string }
  // ---- shared: spec fetch/parse (openapi add + refresh) ----
  | { kind: "spec-fetch-failed"; cause: unknown }
  | { kind: "spec-parse-failed"; cause: unknown }
  // ---- shared: tool extraction (openapi add + refresh) ----
  | { kind: "too-many-tools"; count: number; cap: number; tagCounts: TagCount[] }
  | { kind: "extract-failed"; extractKind: string }
  // ---- shared: base URL resolution (openapi add) ----
  | { kind: "base-url"; reason: "no-base-url" | "base-url-has-variables" | "invalid-base-url" }
  // ---- shared: zod validation failures ----
  | { kind: "invalid-connection"; message: string }
  | { kind: "invalid-platform"; message: string }
  // ---- graphql ----
  | { kind: "apikey-in-query-unsupported" }
  // ---- cli ----
  | { kind: "invalid-descriptor"; message: string }
  | { kind: "policy-invalid"; toolName: string; reason: string }
  // ---- openapi spec cache write (add + refresh) ----
  | { kind: "spec-cache-failed"; cause: unknown }
  // ---- refresh ----
  | { kind: "not-openapi"; platformKind: string }
  | { kind: "not-url-spec"; specFrom: string }

/**
 * Map a parseSpec UpstreamError (only ever "spec-fetch-failed" or "spec-parse-failed"
 * in practice) to the corresponding PlatformOrchestrationError kind.
 */
export function mapSpecError(e: UpstreamError): PlatformOrchestrationError {
  return e.kind === "spec-fetch-failed"
    ? { kind: "spec-fetch-failed", cause: e.cause }
    : { kind: "spec-parse-failed", cause: "cause" in e ? e.cause : e.kind }
}
