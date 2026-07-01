// SPDX-License-Identifier: AGPL-3.0-only
// auth.ts — shared auth-descriptor helpers used by the openapi and graphql add paths.
// Mirrors buildPlatformAuth/deriveAuthFromSpec from the original cli/commands/platform.ts,
// adapted to take structured input instead of raw CLI `args`.

import type { OpenApiConnection } from "@junction/core"
import { err, ok, type Result } from "neverthrow"
import type { PlatformOrchestrationError } from "./errors.js"

/** Caller-facing input for buildPlatformAuth — mirrors the CLI's --auth-* flags. */
export interface AuthInput {
  scheme?: "apiKey" | "bearer" | "basic"
  in?: "header" | "query" | "cookie"
  name?: string
  username?: string
}

/**
 * Build the auth descriptor from the shared auth-scheme/in/name/username input.
 * Returns undefined if no scheme is given (caller may apply a source-specific fallback).
 */
export function buildPlatformAuth(
  input: AuthInput,
): Result<OpenApiConnection["auth"] | undefined, PlatformOrchestrationError> {
  const authScheme = input.scheme
  if (authScheme === "apiKey") {
    const authIn = input.in ?? "header"
    const authName = input.name
    if (!authName) {
      return err({ kind: "missing-field", field: "auth-name", context: "apiKey auth scheme" })
    }
    if (authIn !== "header" && authIn !== "query" && authIn !== "cookie") {
      return err({
        kind: "invalid-connection",
        message: "auth-in must be header, query, or cookie",
      })
    }
    return ok({ scheme: "apiKey", in: authIn, name: authName })
  }
  if (authScheme === "bearer") {
    return ok({ scheme: "bearer", header: "Authorization" })
  }
  if (authScheme === "basic") {
    const username = input.username
    if (!username) {
      return err({ kind: "missing-field", field: "auth-username", context: "basic auth scheme" })
    }
    return ok({ scheme: "basic", username })
  }
  if (authScheme) {
    return err({
      kind: "invalid-connection",
      message: `Unknown auth scheme "${authScheme}". Must be apiKey, bearer, or basic.`,
    })
  }
  return ok(undefined) // no scheme provided — caller applies source-specific fallback
}

/** Derive auth from the spec's securitySchemes (best-effort). */
export function deriveAuthFromSpec(schema: Record<string, unknown>): OpenApiConnection["auth"] {
  const components = schema.components
  if (components === null || typeof components !== "object") return undefined

  const schemes = (components as Record<string, unknown>).securitySchemes
  if (schemes === null || typeof schemes !== "object") return undefined

  for (const [, scheme] of Object.entries(schemes as Record<string, unknown>)) {
    if (scheme === null || typeof scheme !== "object") continue
    const s = scheme as Record<string, unknown>

    if (s.type === "apiKey") {
      const location = s.in
      const name = s.name
      if (
        typeof name === "string" &&
        (location === "header" || location === "query" || location === "cookie")
      ) {
        return { scheme: "apiKey", in: location, name }
      }
    }

    if (s.type === "http") {
      const httpScheme = s.scheme
      if (httpScheme === "bearer") return { scheme: "bearer", header: "Authorization" }
      if (httpScheme === "basic") {
        // Can't derive username from spec — caller must provide --auth-username
        return undefined
      }
    }

    if (s.type === "oauth2") {
      return { scheme: "oauth2" }
    }
  }

  return undefined
}
