// SPDX-License-Identifier: AGPL-3.0-only
// provider.ts — createOpenApiProvider: wraps parse + tools + http as a ToolProvider.
// SOURCE-AGNOSTIC: no vendor-specific code.

import type { OpenApiConnection, ToolProvider } from "@junction/core"
import { callOperation } from "./http.js"
import { parseSpec } from "./parse.js"
import { extractTools } from "./tools.js"

/**
 * Build a ToolProvider for an OpenAPI/REST source.
 *
 * listTools: loads the (cached) spec, extracts operations as ProviderTool[].
 * callTool: finds the operation, builds the HTTP request, injects the credential,
 *           fetches with timeout/byte-cap, returns the result.
 * close: stateless HTTP — no-op.
 *
 * SECRET DISCIPLINE: `secret` is passed to callOperation which injects it ONLY
 * into the HTTP request (never stored on the provider, never in results/logs).
 *
 * RAW NAMES: returns raw operationId-derived names. The core proxy applies
 * namespacing and toolFilter on top.
 */
export function createOpenApiProvider(
  connection: OpenApiConnection,
  secret: string | null,
): ToolProvider {
  const cap = connection.maxTools ?? 75
  // Parse once — both listTools and callTool chain on the same promise so the spec
  // is validated and dereferenced only once per provider lifetime.
  const parsedSpec = parseSpec(connection.spec)

  return {
    listTools() {
      // Pass the stored selection so serve/debug expose exactly the persisted slice —
      // not the full cached spec. This is the runtime enforcement of the add-time filter.
      return parsedSpec.andThen(({ schema }) => extractTools(schema, cap, connection.select))
    },

    callTool(rawName: string, args: Record<string, unknown>) {
      return parsedSpec.andThen(({ schema }) =>
        callOperation(schema, connection, secret, rawName, args),
      )
    },

    async close(): Promise<void> {
      // Stateless HTTP — nothing to close.
    },
  }
}
