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
//
// AUDIT-EMIT EXTRACTION (increment 33 Slice A): the entry-building logic that
// used to live inline here moved to core's emitToolCall (core/src/audit/
// emit.ts) so a later code-mode package can emit BYTE-IDENTICAL tool_call
// lines through the same seam. `parseWireName` moved with it (core/src/audit/
// wire-name.ts) — both are re-exported from @junction/core; this file now
// only derives the AuditTarget and calls emitToolCall. No behavior change.

import {
  type AuditPrincipal,
  type AuditSink,
  emitToolCall,
  type OnDescriptionDriftFn,
  type OnPinStoreWarningFn,
  parseWireName,
  type ResultAsync,
  type UpstreamError,
} from "@junction/core"
import type { McpServerHandlers } from "@junction/mcp-server"

// ---------------------------------------------------------------------------
// makeProxyWarnCallbacks — the standard createProfileProxy drift/pin warns
// ---------------------------------------------------------------------------

/**
 * Build the two structured warn callbacks every CLI command passes to
 * createProfileProxy: `onDescriptionDrift` (tool-poisoning sanitize +
 * hash-pin rug-pull detection, discriminated by info.reason) and
 * `onPinStoreWarning` (pin-STORE degradation — a corrupt/failed pins file
 * that would otherwise silently disable rug-pull detection).
 *
 * Shared by `junction run`, `junction mcp serve`, and `junction serve`, which
 * previously inlined byte-identical closures. The single difference — WHERE
 * the structured line goes — is injected as `emit`: run/serve use
 * consola.warn (stderr, human/JSON), `mcp serve` uses process.stderr.write
 * (stdout is the MCP protocol channel there). Metadata only: never the
 * (possibly-injected) description text, never old/new hashes.
 */
export function makeProxyWarnCallbacks(emit: (event: Record<string, unknown>) => void): {
  onDescriptionDrift: OnDescriptionDriftFn
  onPinStoreWarning: OnPinStoreWarningFn
} {
  return {
    onDescriptionDrift: (info) => {
      emit({
        event: info.reason === "pin-drift" ? "tool_pin_drift" : "description_sanitized",
        namespace: info.namespace,
        tool: info.tool,
        strippedSuspicious: info.strippedSuspicious,
        truncated: info.truncated,
        reason: info.reason,
      })
    },
    onPinStoreWarning: (info) => {
      emit({ event: "tool_pin_store_degraded", op: info.op, detail: info.detail })
    },
  }
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
        const singleProfile = audit.principal.profiles[0] ?? ""
        const target = parseWireName(name, audit.prefixed, singleProfile)
        emitToolCall({
          sink: audit.sink,
          principal: audit.principal,
          target,
          args: callArgs,
          outcome: result.isErr() ? "error" : "ok",
          durationMs: performance.now() - start,
          errorKind: result.isErr() ? result.error.kind : null,
          correlationId,
        })
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
