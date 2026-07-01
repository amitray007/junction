// SPDX-License-Identifier: AGPL-3.0-only
// graphql.ts — assemble a GraphQL Platform. Mirrors addGraphQlPlatform from the
// original cli/commands/platform.ts: validate endpoint, reject apiKey-in-query,
// merge default headers, validate the connection, introspect (warn-not-fail),
// validate the platform.

import {
  type GraphQlConnection,
  GraphQlConnectionSchema,
  type Platform,
  PlatformSchema,
} from "@junction/core"
import { introspectSchema } from "@junction/graphql-client"
import { err, ok, type Result, ResultAsync } from "neverthrow"
import type { AuthInput } from "./auth.js"
import { buildPlatformAuth } from "./auth.js"
import type { PlatformOrchestrationError } from "./errors.js"

export interface AddGraphQlPlatformInput {
  id: string
  displayName: string
  endpoint: string
  auth?: AuthInput
  /** Already-merged headers (the CLI/web shell parses --header key=value and seeds User-Agent). */
  defaultHeaders?: Record<string, string>
}

export interface AddGraphQlPlatformResult {
  platform: Platform
  sdlCached: boolean
}

export function addGraphQlPlatform(
  input: AddGraphQlPlatformInput,
): ResultAsync<AddGraphQlPlatformResult, PlatformOrchestrationError> {
  return new ResultAsync(addGraphQlPlatformAsync(input))
}

async function addGraphQlPlatformAsync(
  input: AddGraphQlPlatformInput,
): Promise<Result<AddGraphQlPlatformResult, PlatformOrchestrationError>> {
  // Validate endpoint URL
  try {
    new URL(input.endpoint)
  } catch {
    return err({
      kind: "invalid-connection",
      message: `endpoint must be a valid URL: "${input.endpoint}"`,
    })
  }

  // Build auth descriptor (reuses the same OpenAPI auth flags; no spec fallback for graphql)
  const authResult = buildPlatformAuth(input.auth ?? {})
  if (authResult.isErr()) return err(authResult.error)
  const auth: GraphQlConnection["auth"] = authResult.value

  // apiKey-in-query is meaningless for a single GraphQL POST endpoint, and the
  // provider would silently send the request unauthenticated. Reject it loudly at
  // add-time rather than persist a config that never authenticates. (Use a header.)
  if (auth?.scheme === "apiKey" && auth.in === "query") {
    return err({ kind: "apikey-in-query-unsupported" })
  }

  // Merge default headers over a sane User-Agent seed
  const defaultHeaders: Record<string, string> = {
    "User-Agent": "junction",
    ...input.defaultHeaders,
  }

  // Build the descriptor stub (no SDL yet — introspect below)
  const descriptorParseResult = GraphQlConnectionSchema.safeParse({
    endpoint: input.endpoint,
    auth,
    defaultHeaders,
  })
  if (!descriptorParseResult.success) {
    const message = descriptorParseResult.error.issues.map((i) => i.message).join(", ")
    return err({ kind: "invalid-connection", message })
  }
  let graphql = descriptorParseResult.data

  // Introspect to cache SDL at add-time (warn + proceed on failure — never fail the add)
  const secret = null // no credential yet at add time — public introspection attempt
  const sdlResult = await introspectSchema(graphql, secret)
  let sdlCached = false
  if (sdlResult.isOk()) {
    graphql = { ...graphql, schemaSdl: sdlResult.value }
    sdlCached = true
  }

  const platformParseResult = PlatformSchema.safeParse({
    id: input.id,
    kind: "graphql",
    displayName: input.displayName,
    graphql,
  })
  if (!platformParseResult.success) {
    const message = platformParseResult.error.issues.map((i) => i.message).join(", ")
    return err({ kind: "invalid-platform", message })
  }

  return ok({ platform: platformParseResult.data, sdlCached })
}
