// SPDX-License-Identifier: AGPL-3.0-only
// http.ts — assemble a user-authored HTTP (REST request-tool) Platform. Mirrors
// addCliPlatform's shape (descriptor authority → platform assembly) minus the
// sandbox probe and policy dry-run — http has no sandbox; the request-binding
// engine's own guards (host-pin, path-injection, byte-cap) live in the provider,
// not at add-time.

import { HttpConnectionSchema, type Platform } from "@junction/core"
import { err, type Result, ResultAsync } from "neverthrow"
import { type PlatformOrchestrationError, parsePlatform } from "./errors.js"

export interface AddHttpPlatformInput {
  id: string
  displayName: string
  /** Already JSON.parsed descriptor object — the caller owns the raw string + its parse error. */
  descriptor: unknown
}

export interface AddHttpPlatformResult {
  platform: Platform
  toolCount: number
}

export function addHttpPlatform(
  input: AddHttpPlatformInput,
): ResultAsync<AddHttpPlatformResult, PlatformOrchestrationError> {
  return new ResultAsync(addHttpPlatformAsync(input))
}

async function addHttpPlatformAsync(
  input: AddHttpPlatformInput,
): Promise<Result<AddHttpPlatformResult, PlatformOrchestrationError>> {
  const httpParseResult = HttpConnectionSchema.safeParse(input.descriptor)
  if (!httpParseResult.success) {
    const message = httpParseResult.error.issues.map((i) => i.message).join(", ")
    return err({ kind: "invalid-descriptor", message })
  }
  const http = httpParseResult.data

  const platformResult = parsePlatform({
    id: input.id,
    kind: "http",
    displayName: input.displayName,
    http,
  })
  if (platformResult.isErr()) return err(platformResult.error)

  return platformResult.map((platform) => ({ platform, toolCount: http.tools.length }))
}
