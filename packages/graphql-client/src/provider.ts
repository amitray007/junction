// SPDX-License-Identifier: AGPL-3.0-only
// provider.ts — createGraphQlProvider: wraps operation enforcement + http + introspect
//               as a ToolProvider with 3 fixed tools.
// SOURCE-AGNOSTIC: no vendor-specific code.

import type { GraphQlConnection, ToolProvider, UpstreamError } from "@junction/core"
import { err, ok, ResultAsync } from "neverthrow"
import { callGraphQl } from "./http.js"
import { introspectSchema } from "./introspect.js"
import { assertOperationType } from "./operation.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_QUERY_BYTES = 100_000

// ---------------------------------------------------------------------------
// Tool input schemas (JSON Schema objects)
// ---------------------------------------------------------------------------

const EXECUTE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The GraphQL document string to execute.",
    },
    variables: {
      type: "object",
      description: "Optional variables for the operation.",
      additionalProperties: true,
    },
    operationName: {
      type: "string",
      description: "Optional operation name when the document contains multiple operations.",
    },
  },
  required: ["query"],
} as const

const SCHEMA_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
} as const

// ---------------------------------------------------------------------------
// createGraphQlProvider
// ---------------------------------------------------------------------------

/**
 * Build a ToolProvider for a GraphQL source.
 *
 * Exposes exactly 3 fixed tools:
 *   graphql_query      — execute a query operation (rejects mutation/subscription)
 *   graphql_mutation   — execute a mutation operation (rejects query/subscription)
 *   graphql_schema     — return the schema SDL (cached or live introspection)
 *
 * READ-ONLY PROFILE GUARANTEE: the proxy toolFilter omits graphql_mutation, AND
 * graphql_query rejects any mutation document at parse time — both layers enforce it.
 *
 * SECRET DISCIPLINE: `secret` is passed to callGraphQl/introspectSchema which inject
 * it ONLY into the HTTP request. Never stored on the provider, never in results/logs.
 *
 * RAW NAMES: returns raw tool names (no namespace prefix). The core proxy applies
 * namespacing and toolFilter on top.
 */
export function createGraphQlProvider(
  connection: GraphQlConnection,
  secret: string | null,
): ToolProvider {
  // Cache the SDL from introspection for the lifetime of this provider instance.
  // Seeded from connection.schemaSdl if present (written at platform-add time).
  let cachedSdl: string | null = connection.schemaSdl ?? null
  // Track whether a live introspection attempt was already made and failed,
  // so we don't spam the endpoint on every graphql_schema call.
  let introspectionFailed = false

  const maxQueryBytes = connection.maxQueryBytes ?? DEFAULT_MAX_QUERY_BYTES

  return {
    listTools() {
      return new ResultAsync(
        Promise.resolve(
          ok([
            {
              name: "graphql_query",
              description:
                "Execute a GraphQL query operation against the endpoint. " +
                "The document must contain a query operation (not mutation or subscription). " +
                "Use graphql_schema first to discover available types and fields.",
              inputSchema: EXECUTE_INPUT_SCHEMA,
            },
            {
              name: "graphql_mutation",
              description:
                "Execute a GraphQL mutation operation against the endpoint. " +
                "The document must contain a mutation operation (not query or subscription). " +
                "Omitted from read-only profiles.",
              inputSchema: EXECUTE_INPUT_SCHEMA,
            },
            {
              name: "graphql_schema",
              description:
                "Return the GraphQL schema as SDL (Schema Definition Language). " +
                "Use this first to discover available types, queries, and mutations.",
              inputSchema: SCHEMA_INPUT_SCHEMA,
            },
          ]),
        ),
      )
    },

    callTool(rawName: string, args: Record<string, unknown>) {
      if (rawName === "graphql_query" || rawName === "graphql_mutation") {
        const query = args.query
        if (typeof query !== "string" || query.length === 0) {
          return new ResultAsync(
            Promise.resolve(
              err<import("@junction/core").ToolResult, UpstreamError>({
                kind: "invalid-args",
                reason: "query is required and must be a non-empty string",
              }),
            ),
          )
        }

        // Guard: reject oversized query documents before any network call
        const queryByteLen = Buffer.byteLength(query, "utf8")
        if (queryByteLen > maxQueryBytes) {
          return new ResultAsync(
            Promise.resolve(
              err<import("@junction/core").ToolResult, UpstreamError>({
                kind: "invalid-args",
                reason: `query document exceeds maxQueryBytes limit (${queryByteLen} > ${maxQueryBytes})`,
              }),
            ),
          )
        }

        const operationName =
          typeof args.operationName === "string" && args.operationName.length > 0
            ? args.operationName
            : undefined

        const variables =
          args.variables !== null &&
          args.variables !== undefined &&
          typeof args.variables === "object" &&
          !Array.isArray(args.variables)
            ? (args.variables as Record<string, unknown>)
            : undefined

        const expectedType = rawName === "graphql_query" ? "query" : "mutation"

        // Enforce operation type via parse (the load-bearing novelty)
        const enforceResult = assertOperationType(query, operationName, expectedType)
        if (enforceResult.isErr()) {
          return new ResultAsync(Promise.resolve(err(enforceResult.error)))
        }

        return callGraphQl(connection, secret, query, variables, operationName)
      }

      if (rawName === "graphql_schema") {
        return new ResultAsync(schemaAsync())
      }

      return new ResultAsync(
        Promise.resolve(
          err<import("@junction/core").ToolResult, UpstreamError>({
            kind: "tool-not-found",
            name: rawName,
          }),
        ),
      )
    },

    async close(): Promise<void> {
      // Stateless HTTP — nothing to close.
    },
  }

  // ---------------------------------------------------------------------------
  // schemaAsync — serve cached SDL, attempt live introspection, or degrade
  // ---------------------------------------------------------------------------

  async function schemaAsync(): Promise<
    import("neverthrow").Result<import("@junction/core").ToolResult, UpstreamError>
  > {
    // Serve the cached SDL immediately if available
    if (cachedSdl !== null) {
      return ok({
        content: [{ type: "text", text: cachedSdl }],
        isError: false,
      })
    }

    // Attempt live introspection once
    if (!introspectionFailed) {
      const result = await introspectSchema(connection, secret)
      if (result.isOk()) {
        cachedSdl = result.value
        return ok({
          content: [{ type: "text", text: cachedSdl }],
          isError: false,
        })
      }
      // Introspection failed — degrade gracefully; keep execution tools usable
      introspectionFailed = true
    }

    // Introspection disabled or unavailable — return a clear message without crashing
    return ok({
      content: [
        {
          type: "text",
          text: "Schema SDL is not available: introspection is disabled on this endpoint and no cached schema was found. You can still use graphql_query and graphql_mutation if you know the schema.",
        },
      ],
      isError: false,
    })
  }
}
