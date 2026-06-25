// SPDX-License-Identifier: AGPL-3.0-only
// Pure tool-name helpers — no transport, unit-testable in isolation.
// SOURCE-AGNOSTIC: no vendor code. A namespace and tool name are data, not code.

import type { UpstreamError } from "@junction/core"
import { err, ok, type Result } from "neverthrow"

/** MCP tool-name charset and length limit per specification (`^[a-zA-Z0-9_-]{1,64}$`). */
const MCP_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Build a namespaced tool name `<namespace>__<toolName>` and validate the
 * combined result against the MCP tool-name rule `^[a-zA-Z0-9_-]{1,64}$`.
 *
 * The `namespace` is already constrained to junction's ToolNamespaceSchema.
 * The upstream `toolName` is NOT re-validated against that schema — MCP allows
 * uppercase and hyphens (e.g. `printEnv`, `get-thing`) that junction's schema
 * does not. Only the COMBINED name is checked here.
 *
 * Returns:
 * - Ok(combined)            — combined name passes MCP charset + length ≤ 64
 * - Err(namespace-too-long) — combined length > 64 (NEVER truncates)
 * - Err(invalid-tool-name)  — combined contains MCP-illegal characters
 */
export function namespaceToolName(ns: string, toolName: string): Result<string, UpstreamError> {
  const combined = `${ns}__${toolName}`
  if (combined.length > 64) {
    return err({ kind: "namespace-too-long" as const, name: combined })
  }
  if (!MCP_TOOL_NAME_RE.test(combined)) {
    return err({ kind: "invalid-tool-name" as const, name: combined })
  }
  return ok(combined)
}

/**
 * Split a `<namespace>__<tool>` name on the FIRST occurrence of `__`.
 *
 * If `__` is absent, `namespace` is `""` and `tool` is the whole string.
 * Splitting on the FIRST `__` is load-bearing: the upstream tool name may
 * itself contain `__` (e.g. `bad__name`) — this is fine because the namespace
 * never contains `__` (ToolNamespaceSchema forbids it), making the first `__`
 * the unambiguous separator.
 */
export function splitNamespacedName(name: string): { namespace: string; tool: string } {
  const idx = name.indexOf("__")
  if (idx === -1) return { namespace: "", tool: name }
  return { namespace: name.slice(0, idx), tool: name.slice(idx + 2) }
}
