// SPDX-License-Identifier: AGPL-3.0-or-later
// parse.ts — fetch/read/inline an OpenAPI spec, validate, dereference.
// Returns the resolved schema document or a typed UpstreamError.
// SOURCE-AGNOSTIC: no vendor-specific code.

import { readFile } from "node:fs/promises"
import type { UpstreamError } from "@junction/core"
import { dereference, upgradeFromTwoToThree, validate } from "@scalar/openapi-parser"
import { err, ok, ResultAsync } from "neverthrow"

// ---------------------------------------------------------------------------
// Internal document type — the dereferenced OpenAPI 3.x document
// ---------------------------------------------------------------------------

/** Minimal shape we extract from the dereferenced schema. */
export interface ParsedSpec {
  /** Raw dereferenced schema object (Record<string, unknown>). */
  schema: Record<string, unknown>
}

const SPEC_FETCH_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// parseSpec
// ---------------------------------------------------------------------------

/**
 * Load, validate, and dereference an OpenAPI specification from any source.
 *
 * SECURITY: Only the spec document itself is fetched; remote $ref resolution
 * inside the dereferencer is NOT used (we pass already-loaded objects).
 */
export function parseSpec(
  source:
    | { from: "url"; url: string }
    | { from: "file"; path: string }
    | { from: "inline"; document: unknown },
): ResultAsync<ParsedSpec, UpstreamError> {
  return new ResultAsync(parseSpecAsync(source))
}

async function parseSpecAsync(
  source:
    | { from: "url"; url: string }
    | { from: "file"; path: string }
    | { from: "inline"; document: unknown },
) {
  // 1. Acquire the raw spec object
  let raw: Record<string, unknown>

  if (source.from === "url") {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SPEC_FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(source.url, { signal: controller.signal, redirect: "manual" })
      if (!res.ok) {
        return err<ParsedSpec, UpstreamError>({
          kind: "spec-fetch-failed",
          cause: `HTTP ${res.status} fetching spec`,
        })
      }
      raw = (await res.json()) as Record<string, unknown>
    } catch (cause) {
      return err<ParsedSpec, UpstreamError>({ kind: "spec-fetch-failed", cause })
    } finally {
      clearTimeout(timer)
    }
  } else if (source.from === "file") {
    try {
      const text = await readFile(source.path, "utf8")
      raw = JSON.parse(text) as Record<string, unknown>
    } catch (cause) {
      return err<ParsedSpec, UpstreamError>({ kind: "spec-fetch-failed", cause })
    }
  } else {
    raw = source.document as Record<string, unknown>
  }

  // 2. Upgrade Swagger 2.0 → OpenAPI 3.0 if needed (synchronous)
  let docToProcess: Record<string, unknown> = raw
  if (typeof raw.swagger === "string" && raw.swagger.startsWith("2")) {
    try {
      const upgraded = upgradeFromTwoToThree(raw)
      // upgradeFromTwoToThree returns an UpgradeResult-like object
      const upg = upgraded as Record<string, unknown>
      docToProcess =
        typeof upg.specification === "object" && upg.specification !== null
          ? (upg.specification as Record<string, unknown>)
          : (upgraded as Record<string, unknown>)
    } catch (cause) {
      return err<ParsedSpec, UpstreamError>({ kind: "spec-parse-failed", cause })
    }
  }

  // 3. Validate the spec (async)
  let validationResult: Awaited<ReturnType<typeof validate>>
  try {
    validationResult = await validate(docToProcess)
  } catch (cause) {
    return err<ParsedSpec, UpstreamError>({ kind: "spec-parse-failed", cause })
  }

  if (!validationResult.valid) {
    const issues = (validationResult.errors ?? []).map((e) => String(e)).join("; ")
    return err<ParsedSpec, UpstreamError>({
      kind: "spec-parse-failed",
      cause: `validation failed: ${issues}`,
    })
  }

  // 4. Dereference (synchronous — resolves internal $refs only; no remote fetching)
  let schema: Record<string, unknown>
  try {
    const derefResult = dereference(docToProcess)
    if (derefResult.errors && derefResult.errors.length > 0) {
      const issues = derefResult.errors.map((e) => String(e)).join("; ")
      return err<ParsedSpec, UpstreamError>({
        kind: "spec-parse-failed",
        cause: `dereference failed: ${issues}`,
      })
    }
    if (!derefResult.schema) {
      return err<ParsedSpec, UpstreamError>({
        kind: "spec-parse-failed",
        cause: "dereference returned no schema",
      })
    }
    schema = derefResult.schema as Record<string, unknown>
  } catch (cause) {
    return err<ParsedSpec, UpstreamError>({ kind: "spec-parse-failed", cause })
  }

  return ok<ParsedSpec, UpstreamError>({ schema })
}
