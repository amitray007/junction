// SPDX-License-Identifier: AGPL-3.0-only
// introspect.ts — fetch the schema SDL via GraphQL introspection.
// SOURCE-AGNOSTIC: no vendor-specific code.

import type { GraphQlConnection, UpstreamError } from "@junction/core"
import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql"
import { err, ok, type ResultAsync } from "neverthrow"
import { callGraphQl } from "./http.js"

// ---------------------------------------------------------------------------
// introspectSchema — POST introspection query → return SDL string
// ---------------------------------------------------------------------------

/**
 * Introspect the endpoint and return the schema as SDL.
 *
 * Returns call-failed if the response is non-2xx or the body is missing
 * `data.__schema` (e.g. introspection disabled); response-too-large /
 * timed-out propagate from the underlying HTTP call.
 *
 * SECURITY: credential injected into the HTTP request only — not in any error.
 */
export function introspectSchema(
  connection: GraphQlConnection,
  secret: string | null,
): ResultAsync<string, UpstreamError> {
  const introspectionQuery = getIntrospectionQuery()

  return callGraphQl(connection, secret, introspectionQuery, undefined, undefined).andThen(
    (result) => {
      const text = Array.isArray(result.content)
        ? ((result.content[0] as { text?: string })?.text ?? "")
        : ""

      let parsed: { data?: { __schema?: unknown }; errors?: unknown[] } | null = null
      try {
        parsed = JSON.parse(text) as { data?: { __schema?: unknown }; errors?: unknown[] }
      } catch {
        return err<string, UpstreamError>({
          kind: "call-failed",
          cause: "introspection response is not valid JSON",
        })
      }

      if (!parsed?.data?.__schema) {
        // Introspection disabled or returned an error
        const errMsg =
          Array.isArray(parsed?.errors) && parsed.errors.length > 0
            ? "introspection returned errors (introspection may be disabled on this endpoint)"
            : "introspection response missing data.__schema"
        return err<string, UpstreamError>({
          kind: "call-failed",
          cause: errMsg,
        })
      }

      try {
        const schema = buildClientSchema(parsed.data as Parameters<typeof buildClientSchema>[0])
        const sdl = printSchema(schema)
        return ok<string, UpstreamError>(sdl)
      } catch (cause) {
        return err<string, UpstreamError>({
          kind: "call-failed",
          cause: `failed to build schema from introspection result: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
    },
  )
}
