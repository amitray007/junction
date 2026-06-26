// SPDX-License-Identifier: AGPL-3.0-or-later
// tools.ts — derive ProviderTool[] from a dereferenced OpenAPI schema.
// SOURCE-AGNOSTIC: no vendor-specific logic.

import type { ProviderTool, UpstreamError } from "@junction/core"
import { err, ok, type Result } from "neverthrow"
import { deriveNameFromMethodPath, sanitizeOperationId } from "./naming.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOOLS = 75

// HTTP methods we recognize as OpenAPI operations
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const

// ---------------------------------------------------------------------------
// Internal OpenAPI types (minimal, from Record<string, unknown>)
// ---------------------------------------------------------------------------

interface OpenApiParameter {
  name?: unknown
  in?: unknown
  required?: unknown
  schema?: unknown
  description?: unknown
}

interface OpenApiOperation {
  operationId?: unknown
  summary?: unknown
  description?: unknown
  parameters?: unknown
  requestBody?: unknown
  tags?: unknown
}

interface OpenApiPathItem {
  [method: string]: unknown
}

// ---------------------------------------------------------------------------
// OpenAPI 3.0 schema normalization — nullable → type array
// ---------------------------------------------------------------------------

/**
 * Normalize an OpenAPI 3.0 schema: convert `nullable: true` to
 * `type: [existingType, "null"]` (JSON Schema draft-07 compatible).
 * Mutates a deep clone to avoid touching the original.
 */
function normalizeSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema
  if (Array.isArray(schema)) return schema.map(normalizeSchema)

  const s = schema as Record<string, unknown>
  const result: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(s)) {
    result[k] = normalizeSchema(v)
  }

  // Convert nullable: true
  if (result.nullable === true) {
    delete result.nullable
    const existing = result.type
    if (typeof existing === "string") {
      result.type = [existing, "null"]
    } else if (Array.isArray(existing)) {
      if (!existing.includes("null")) {
        result.type = [...existing, "null"]
      }
    } else {
      result.type = ["null"]
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Build JSON Schema for one parameter
// ---------------------------------------------------------------------------

function paramToJsonSchema(param: OpenApiParameter): {
  name: string
  schema: Record<string, unknown>
  required: boolean
} | null {
  if (typeof param.name !== "string" || param.name.length === 0) return null

  const rawSchema =
    param.schema !== null && typeof param.schema === "object"
      ? (param.schema as Record<string, unknown>)
      : { type: "string" }

  const normalized = normalizeSchema(rawSchema) as Record<string, unknown>

  if (typeof param.description === "string") {
    normalized.description = param.description
  }

  return {
    name: param.name,
    schema: normalized,
    required: param.required === true,
  }
}

// ---------------------------------------------------------------------------
// Build the merged inputSchema for one operation
// ---------------------------------------------------------------------------

function buildInputSchema(op: OpenApiOperation): object {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  // Path + query + header + cookie params
  const params = Array.isArray(op.parameters) ? op.parameters : []
  for (const p of params) {
    if (p === null || typeof p !== "object") continue
    const param = p as OpenApiParameter
    const loc = param.in
    // Include path, query, header, cookie params
    if (loc !== "path" && loc !== "query" && loc !== "header" && loc !== "cookie") continue

    const built = paramToJsonSchema(param)
    if (!built) continue

    properties[built.name] = built.schema
    if (built.required) required.push(built.name)
  }

  // requestBody → merge under "body"
  if (op.requestBody !== null && typeof op.requestBody === "object") {
    const rb = op.requestBody as Record<string, unknown>
    const content = rb.content
    if (content !== null && typeof content === "object") {
      const contentMap = content as Record<string, unknown>
      const jsonContent = contentMap["application/json"]
      if (jsonContent !== null && typeof jsonContent === "object") {
        const jsonEntry = jsonContent as Record<string, unknown>
        const bodySchema = jsonEntry.schema
        if (bodySchema !== null && typeof bodySchema === "object") {
          properties.body = normalizeSchema(bodySchema)
          if (rb.required === true) required.push("body")
        }
      }
    }
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
  }
  if (required.length > 0) {
    schema.required = required
  }
  return schema
}

// ---------------------------------------------------------------------------
// extractTools
// ---------------------------------------------------------------------------

/**
 * Extract ProviderTool[] from a dereferenced OpenAPI schema.
 * Returns raw (un-namespaced) tool names.
 * Returns too-many-tools if the operation count exceeds cap.
 */
export function extractTools(
  schema: Record<string, unknown>,
  cap = DEFAULT_MAX_TOOLS,
): Result<ProviderTool[], UpstreamError> {
  const paths = schema.paths
  if (paths === null || typeof paths !== "object") {
    return ok([])
  }

  const pathsMap = paths as Record<string, OpenApiPathItem>
  const tools: ProviderTool[] = []
  // Track used names to detect collisions
  const usedNames = new Set<string>()

  for (const [path, pathItem] of Object.entries(pathsMap)) {
    if (pathItem === null || typeof pathItem !== "object") continue

    for (const method of HTTP_METHODS) {
      const op = pathItem[method]
      if (op === null || op === undefined) continue
      if (typeof op !== "object") continue

      const operation = op as OpenApiOperation

      // Derive tool name
      let name: string
      if (typeof operation.operationId === "string" && operation.operationId.length > 0) {
        name = sanitizeOperationId(operation.operationId)
      } else {
        name = deriveNameFromMethodPath(method, path)
      }

      // Deduplicate by appending _2, _3, etc.
      let finalName = name
      if (usedNames.has(finalName)) {
        let suffix = 2
        while (usedNames.has(`${name}_${suffix}`)) suffix++
        finalName = `${name}_${suffix}`.slice(0, 64)
      }
      usedNames.add(finalName)

      // Description
      const description =
        typeof operation.summary === "string"
          ? operation.summary
          : typeof operation.description === "string"
            ? operation.description
            : undefined

      // Input schema
      const inputSchema = buildInputSchema(operation)

      tools.push({ name: finalName, description, inputSchema })
    }
  }

  if (tools.length > cap) {
    return err<ProviderTool[], UpstreamError>({
      kind: "too-many-tools",
      count: tools.length,
      cap,
    })
  }

  return ok(tools)
}

// ---------------------------------------------------------------------------
// Tag counting — for the CLI refusal message
// ---------------------------------------------------------------------------

export interface TagCount {
  tag: string
  count: number
}

/**
 * Count operations per tag (for refusal message when too many ops).
 */
export function countOperationsByTag(schema: Record<string, unknown>): TagCount[] {
  const paths = schema.paths
  if (paths === null || typeof paths !== "object") return []

  const pathsMap = paths as Record<string, OpenApiPathItem>
  const tagCounts: Record<string, number> = { "(untagged)": 0 }

  for (const [, pathItem] of Object.entries(pathsMap)) {
    if (pathItem === null || typeof pathItem !== "object") continue

    for (const method of HTTP_METHODS) {
      const op = pathItem[method]
      if (op === null || op === undefined || typeof op !== "object") continue

      const operation = op as OpenApiOperation
      const tags = Array.isArray(operation.tags)
        ? (operation.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : []

      if (tags.length === 0) {
        const untagged = tagCounts["(untagged)"] ?? 0
        tagCounts["(untagged)"] = untagged + 1
      } else {
        for (const tag of tags) {
          const prev = tagCounts[tag] ?? 0
          tagCounts[tag] = prev + 1
        }
      }
    }
  }

  return Object.entries(tagCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }))
}

// Re-export ok for callers
export { ok }
