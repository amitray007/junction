// SPDX-License-Identifier: AGPL-3.0-only
// Pure tool-name helpers — no transport, unit-testable in isolation.
// SOURCE-AGNOSTIC: no vendor code. A namespace and tool name are data, not code.

import type { UpstreamError } from "@junction/core"
import { namespacedTool } from "@junction/core"
import { err, ok, type Result } from "neverthrow"

/** Maximum tool-name length per MCP specification (`^[a-zA-Z0-9_-]{1,64}$`). */
const MAX_TOOL_NAME_LENGTH = 64

/**
 * Build a namespaced tool name `<namespace>__<toolName>` and guard that the
 * result does not exceed 64 characters (the MCP tool-name limit).
 *
 * Returns `namespace-too-long` if the prefixed name exceeds the limit or if
 * the namespace/toolName does not satisfy the ToolNamespaceSchema convention.
 * NEVER truncates — truncation would break routing when the name is split.
 */
export function namespaceToolName(ns: string, toolName: string): Result<string, UpstreamError> {
  let prefixed: string
  try {
    prefixed = namespacedTool(ns, toolName)
  } catch {
    // namespacedTool throws when ns or toolName violates ToolNamespaceSchema.
    prefixed = `${ns}__${toolName}`
    return err({ kind: "namespace-too-long" as const, name: prefixed })
  }
  if (prefixed.length > MAX_TOOL_NAME_LENGTH) {
    return err({ kind: "namespace-too-long" as const, name: prefixed })
  }
  return ok(prefixed)
}

/**
 * Split a `<namespace>__<tool>` name on the FIRST occurrence of `__`.
 *
 * If `__` is absent, `namespace` is `""` and `tool` is the whole string.
 * Splitting on the FIRST `__` is load-bearing: the tool name itself may
 * contain single underscores, but the convention forbids `__` within either
 * part (ToolNamespaceSchema), so the first occurrence is unambiguous.
 */
export function splitNamespacedName(name: string): { namespace: string; tool: string } {
  const idx = name.indexOf("__")
  if (idx === -1) return { namespace: "", tool: name }
  return { namespace: name.slice(0, idx), tool: name.slice(idx + 2) }
}
