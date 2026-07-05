// SPDX-License-Identifier: AGPL-3.0-only
// tools.ts — derive a flat JSON Schema inputSchema from an HttpRequestTool's
// declared params. Mirrors openapi-client/tools.ts's paramToJsonSchema type
// mapping (string/number/boolean/enum → JSON schema, + anchored pattern +
// maxLength) and cli/provider.ts's buildInputSchema shape (one flat object,
// additionalProperties:false). Simpler than either: params are already typed
// (HttpParam), no raw spec objects to normalize.
//
// SOURCE-AGNOSTIC: no vendor-specific logic.

import type { HttpParam, HttpRequestTool } from "@junction/core"

/**
 * Build the flat inputSchema for one operator-declared HTTP request-tool.
 * Every declared param — regardless of `in` (path/query/header/body) —
 * flattens into ONE JSON Schema object keyed by the param's own name; the
 * binding location is invisible to the agent (mirrors OpenAPI's merged
 * inputSchema, and CLI's flat arg schema).
 */
export function buildHttpInputSchema(tool: HttpRequestTool): object {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const param of tool.params) {
    properties[param.name] = paramToJsonSchema(param)
    if (param.required) required.push(param.name)
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function paramToJsonSchema(param: HttpParam): Record<string, unknown> {
  let schema: Record<string, unknown>

  switch (param.type) {
    case "boolean":
      schema = { type: "boolean" }
      break
    case "number":
      schema = { type: "number" }
      break
    case "enum":
      schema = { type: "string", enum: param.enum ?? [] }
      break
    case "string": {
      schema = { type: "string" }
      if (param.pattern !== undefined) {
        // Surface as anchored pattern so agent-side validators can pre-check.
        schema.pattern = `^(?:${param.pattern})$`
      }
      if (param.maxLength !== undefined) {
        schema.maxLength = param.maxLength
      }
      break
    }
    default: {
      // Exhaustiveness guard — TS 6 does not emit a default for this switch;
      // the never-assignment proves all variants are handled at compile time.
      const _: never = param.type
      schema = { type: "string" }
      break
    }
  }

  if (param.description !== undefined) {
    schema.description = param.description
  }

  return schema
}
