// SPDX-License-Identifier: AGPL-3.0-only
// createAuditedInvoker — wraps a raw ToolInvoker (a ProfileProxy satisfies
// this shape structurally) into the POST-audit AuditedInvoker surface the
// executor drives, auditing EVERY call through Slice A's shared
// emitToolCall seam (a security contract, not observability — see the
// method file's hard invariants: "No un-audited batch").
//
// Reuses the SAME seam adaptToMcpHandlers (cli/providers.ts) uses for
// MCP-served calls, so a code-mode tool_call line is byte-identical in
// shape to an MCP-served one — same schema, same redaction (argKeys +
// argHash only, never a value), same errorKind discrimination.
//
// SECRET DISCIPLINE: this file keeps the RAW, TYPED `UpstreamError` on the
// Err path (audit needs the discriminated `errorKind` tag, never a message
// string). Mapping that typed error down to an opaque guest-facing STRING
// via `safeUpstreamMessage` is the CALLER's job (quickjs-executor.ts, right
// before the value crosses into the guest) — kept out of this file so
// createAuditedInvoker stays runtime-agnostic (a future Deno-subprocess
// executor would apply its own guest-error mapping over the same typed
// Err).

import type { ProviderTool, ToolResult, UpstreamError } from "@junction/core"
import {
  type AuditPrincipal,
  type AuditSink,
  emitToolCall,
  splitNamespacedName,
} from "@junction/core"
import { err, ok, type Result } from "neverthrow"
import type { ToolInvoker } from "./types.js"

/**
 * The raw (un-audited) proxy this invoker wraps — structurally identical to
 * `ToolInvoker` (see types.ts's header: both are the "what execute()
 * receives" shape). Named separately here only for readability at the call
 * site (`{ proxy: ... }` reads clearer than `{ proxy: ToolInvoker }` when
 * the OUTPUT of this function is itself a `ToolInvoker`-shaped
 * `AuditedInvoker`).
 */
export type ProxyLike = ToolInvoker

export interface CreateAuditedInvokerOptions {
  proxy: ProxyLike
  sink: AuditSink
  principal: AuditPrincipal
  /** The routed profile this execution is running against (audit target). */
  profile: string
  /**
   * The SAME correlationId used for this execution's wrapping code_exec
   * line (see quickjs-executor.ts) — every tool_call line this invoker
   * emits is tagged with it so a reader can join code_exec ↔ tool_call.
   */
  correlationId: string
}

/**
 * The POST-audit, guest-facing invoker shape — distinct from `ToolInvoker`
 * (the RAW pre-audit shape `execute()` receives, see types.ts's header):
 * `listTools()` here NEVER fails (a listTools Err degrades to an empty
 * facade rather than surfacing a Result the QuickJS facade-builder would
 * have to unwrap), and `callTool` is individually audited on every call —
 * this is what quickjs-executor.ts's facade bridge actually drives.
 */
export interface AuditedInvoker {
  listTools(): Promise<ProviderTool[]>
  callTool(name: string, args: Record<string, unknown>): Promise<Result<ToolResult, UpstreamError>>
  /** How many callTool invocations have completed (ok or error) so far. */
  readonly toolCallCount: number
}

/**
 * Build an AuditedInvoker that audits every callTool individually.
 *
 * listTools is NOT audited (increment 31/33 scope decision — see
 * proxy.ts's header: "listTools/tools-list enumeration auditing is out of
 * scope", docs/futures/revisit-when.md). Only callTool crosses the audit
 * boundary.
 */
export function createAuditedInvoker(options: CreateAuditedInvokerOptions): AuditedInvoker {
  const { proxy, sink, principal, profile, correlationId } = options
  let toolCallCount = 0

  return {
    get toolCallCount() {
      return toolCallCount
    },

    async listTools(): Promise<ProviderTool[]> {
      const result = await proxy.listTools()
      if (result.isErr()) return []
      return result.value
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<Result<ToolResult, UpstreamError>> {
      const { namespace, tool } = splitNamespacedName(name)
      const start = performance.now()
      const result = await proxy.callTool(name, args)
      const durationMs = performance.now() - start
      toolCallCount += 1

      emitToolCall({
        sink,
        principal,
        target: { profile, namespace, tool },
        args,
        outcome: result.isErr() ? "error" : "ok",
        durationMs,
        errorKind: result.isErr() ? result.error.kind : null,
        correlationId,
      })

      if (result.isErr()) {
        // TYPED Err propagates as-is — the caller (quickjs-executor.ts)
        // maps it to an opaque guest-facing string via safeUpstreamMessage
        // right before it crosses into the guest. Never leaked as-is.
        return err(result.error)
      }
      return ok(result.value)
    },
  }
}
