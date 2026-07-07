// SPDX-License-Identifier: AGPL-3.0-only
// adaptToMcpHandlers — ResultAsync proxy → Promise-based McpServerHandlers.
//
// This stays in cli (not @junction/source-runtime): it bridges a core proxy
// to the McpServerHandlers shape, a serving composition-root concern that
// needs @junction/mcp-server. Keeping it here keeps source-runtime free of an
// mcp-server edge — see docs/methods/28-web-probe-call.md, "Boundary note —
// why adaptToMcpHandlers stays in cli".
//
// buildProvider / resolveCredentialSecret / makeResolveProvider moved to
// @junction/source-runtime (increment 28) — import them from there.
//
// AUDIT HOOK (increment 31 Slice B): `adaptToMcpHandlers` is the single seam
// traversed by BOTH transports (stdio + HTTP) where WHO (principal), WHAT
// (name/args), and OUTCOME (the Result) all converge — see docs/methods/
// 31-audit.md §2. The hook is OPT-IN via the optional `principal`/`sink`/
// `prefixed` params: a caller that omits them (or the HTTP failed-resolve
// fallback) gets the unaudited behavior unchanged.

import {
  type AuditEntry,
  type AuditPrincipal,
  type AuditSink,
  type AuditTarget,
  argKeys,
  hashArgs,
  type ResultAsync,
  splitNamespacedName,
  type UpstreamError,
} from "@junction/core"
import type { McpServerHandlers } from "@junction/mcp-server"

// ---------------------------------------------------------------------------
// parseWireName — arity-aware split of the FULL wire tool name (audit only)
// ---------------------------------------------------------------------------

/**
 * Split the wire-format tool name into `{ profile, namespace, tool }` for the
 * AUDIT target — NOT used for routing (the proxy itself already routes the
 * call; this just re-derives the same split for the audit line).
 *
 * LOAD-BEARING (docs/methods/31-audit.md §2 B3-name-parse): the shape of
 * `name` depends on arity:
 *   - unprefixed (`prefixed:false` — single-profile stdio / scope:"profile"):
 *     `name` is `<namespace>__<tool>` → `splitNamespacedName` alone is
 *     correct; `profile` comes from the principal's single profile.
 *   - prefixed (`prefixed:true` — scope:"profiles"|"global"): `name` is
 *     `<profileName>__<namespace>__<tool>`. Calling `splitNamespacedName`
 *     directly would WRONGLY read `namespace = <profileName>`. So: split ONCE
 *     on the FIRST `__` to peel `<profileName>` (charset contract — profile
 *     names carry no `_`, namespaces carry no `__` — scoped-proxy.ts), THEN
 *     `splitNamespacedName` the remainder for `{namespace, tool}`.
 */
function parseWireName(name: string, prefixed: boolean, singleProfile: string): AuditTarget {
  if (!prefixed) {
    const { namespace, tool } = splitNamespacedName(name)
    return { profile: singleProfile, namespace, tool }
  }

  const idx = name.indexOf("__")
  if (idx === -1) {
    // No separator at all — shouldn't happen for a validly-routed prefixed
    // name, but stay fail-safe rather than throw from an audit-only path.
    return { profile: "", namespace: "", tool: name }
  }
  const profile = name.slice(0, idx)
  const remainder = name.slice(idx + 2)
  const { namespace, tool } = splitNamespacedName(remainder)
  return { profile, namespace, tool }
}

// ---------------------------------------------------------------------------
// adaptToMcpHandlers — ResultAsync proxy → Promise-based McpServerHandlers
// ---------------------------------------------------------------------------

/**
 * Adapt a core proxy (ProfileProxy or ScopedProxy — both ResultAsync-based)
 * to McpServerHandlers (Promise-based), the shape createMcpServer / serveStdio
 * / serveHttp expect.
 *
 * Shared between `junction mcp serve` (wraps a single ProfileProxy) and
 * `junction serve` (wraps a ScopedProxy over multiple profiles) — both need
 * the identical Result→Promise unwrap plus the safe-error-message mapping on
 * callTool. `safeUpstreamMessage` is lazy-imported (mirrors the mcp-server
 * import pattern already used at each call site) so cli commands that never
 * hit this path don't pay for it.
 *
 * SECURITY: callTool's error path renders via safeUpstreamMessage — NO
 * secret value is ever placed in the response. The audit hook (when wired)
 * emits `argKeys` + a hash only — NEVER an arg value, the error `cause`, or
 * the response body (see docs/methods/31-audit.md §3 hard list).
 *
 * @param audit - optional attribution for the audit hook. When omitted, no
 *   audit line is emitted (matches prior unaudited behavior). `principal` is
 *   WHO is calling; `sink` is where the line goes; `prefixed` is the arity of
 *   the wire tool name (see `parseWireName`).
 */
export function adaptToMcpHandlers(
  proxy: {
    listTools: () => ResultAsync<
      Array<{ name: string; description?: string; inputSchema: object }>,
      UpstreamError
    >
    callTool: (
      name: string,
      args: Record<string, unknown>,
    ) => ResultAsync<{ content: unknown; isError?: boolean }, UpstreamError>
  },
  audit?: { principal: AuditPrincipal; sink: AuditSink; prefixed: boolean },
): McpServerHandlers {
  return {
    async listTools() {
      const result = await proxy.listTools()
      // listTools always Ok (per-source resilience); if somehow Err, return empty.
      if (result.isErr())
        return { tools: [] as Array<{ name: string; description?: string; inputSchema: object }> }
      return { tools: result.value }
    },
    async callTool(name: string, callArgs: Record<string, unknown>) {
      // Per-invocation locals (LOAD-BEARING — never hoisted to sink/session
      // scope, else every audit line would share one id/duration).
      const correlationId = crypto.randomUUID()
      const start = performance.now()

      const result = await proxy.callTool(name, callArgs)

      if (audit !== undefined) {
        try {
          const singleProfile = audit.principal.profiles[0] ?? ""
          const target = parseWireName(name, audit.prefixed, singleProfile)
          const entry: AuditEntry = {
            v: 1,
            ts: new Date().toISOString(),
            event: "tool_call",
            correlationId,
            principal: audit.principal,
            target,
            argKeys: argKeys(callArgs),
            argHash: hashArgs(callArgs),
            durationMs: performance.now() - start,
            outcome: result.isErr() ? "error" : "ok",
            errorKind: result.isErr() ? result.error.kind : null,
          }
          audit.sink.emit(entry)
        } catch {
          // Audit failure must NEVER break or delay the tool call.
        }
      }

      if (result.isErr()) {
        // Map to a safe MCP error response — NO secret in the message.
        const { safeUpstreamMessage } = await import("@junction/mcp-server")
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: safeUpstreamMessage(result.error) }],
        }
      }
      // Forward the upstream result. Content comes from the upstream MCP server
      // (data, not secrets). isError reflects whether the upstream flagged an error.
      return {
        content: result.value.content as Array<{ type: "text"; text: string }>,
        isError: result.value.isError,
      }
    },
  }
}
