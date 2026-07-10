// SPDX-License-Identifier: AGPL-3.0-only
// buildRunCodeHandlers — the synthetic `junction__run_code` MCP tool
// (increment 33 Slice C, code-mode's MCP surface). Wraps a set of routed
// ProfileProxy entries into an ADDITIONAL McpServerHandlers-shaped fragment
// (one synthetic tool) that the cli composition root (commands/mcp.ts,
// commands/serve.ts) merges alongside the real proxied tools built by
// adaptToMcpHandlers (providers.ts).
//
// WHY A SEPARATE MODULE (not folded into adaptToMcpHandlers): the synthetic
// tool needs @junction/code-mode (a heavy QuickJS/WASM dependency) and its
// OWN per-profile routing (arity-aware wire naming), which is a genuinely
// distinct concern from adaptToMcpHandlers's job of adapting ONE proxy's
// REAL tools. Keeping them separate means a caller that never touches
// code-mode (e.g. a future headless proxy-only consumer) doesn't pay for the
// WASM import — @junction/code-mode is lazy-imported inside buildRunCodeTool
// below, mirroring the mcp-server / safeUpstreamMessage lazy-import pattern
// already used at every serve call site.
//
// ARITY (mirrors scoped-proxy.ts's contract exactly):
//   prefixed:false (single profile, stdio / scope:"profile") → the synthetic
//     tool is named `junction__run_code` (unprefixed).
//   prefixed:true  (scope:"profiles"/"global", HTTP multi-profile) → ONE
//     synthetic tool PER routed profile, named
//     `<profileName>__junction__run_code` — never a cross-profile fan-out
//     tool (the method file's Do NOT list: "no multi-profile fan-out inside
//     one execution" — each execution's engine sees exactly ONE profile's
//     filtered tools).
//
// THE ENGINE SEES ONLY THE FILTERED FACADE: each synthetic tool's ToolInvoker
// is the profile's OWN (unprefixed) ProfileProxy — the SAME proxy object the
// server already built for that profile's real tools. No new access path;
// runCode/QuickJsExecutor always calls this with prefixed:false internally
// (code-mode's facade only ever sees ONE profile's raw namespaced names,
// regardless of the OUTER wire-name arity used to dispatch to it).
//
// RESERVED-NAMESPACE GUARD POINT 2 of 2 (serve-time read-guard): guard point
// 1 is the schema .refine on ToolNamespaceSchema/ProfileNameSchema (core/src/
// schema/primitives.ts) for NEW sources. This module is guard point 2 — a
// LEGACY DB row could hold a `junction`-namespaced source the schema can't
// retroactively clean (it was written before the reserve landed, or the DB
// was edited out of band). `hasLegacyJunctionCollision` inspects the
// profile's OWN filtered listTools() (never a broader surface) for any name
// starting with `junction__`; if found, the synthetic tool for THAT profile
// is refused + `onReservedNamespaceCollision` fires (the caller decides
// where the warning goes — stderr on stdio, consola on HTTP) — the synthetic
// tool is never silently shadowed by, nor silently shadows, a legacy source.

import type {
  AuditPrincipal,
  AuditSink,
  Profile,
  ProfileProxy,
  ProviderTool,
  Result,
  ToolResult,
  UpstreamError,
} from "@junction/core"
import type { McpServerHandlers } from "@junction/mcp-server"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One profile routed into this server/session, paired with its own (unprefixed) ProfileProxy. */
export interface RunCodeEntry {
  profileName: Profile["name"]
  proxy: ProfileProxy
}

export interface BuildRunCodeHandlersOptions {
  entries: RunCodeEntry[]
  /** false (stdio / scope:"profile"): unprefixed `junction__run_code`.
   *  true (scope:"profiles"/"global"): one `<profileName>__junction__run_code` per entry. */
  prefixed: boolean
  principal: AuditPrincipal
  sink: AuditSink
  /** Fired once per profile whose synthetic tool was refused due to a legacy
   *  `junction__*` collision (guard point 2). Never throws into the caller. */
  onReservedNamespaceCollision: (info: { profileName: string }) => void
}

/** The synthetic-tool fragment: same shape as McpServerHandlers so the
 *  caller can merge it with the real proxied handlers via mergeHandlers. */
export type RunCodeHandlers = McpServerHandlers

// ---------------------------------------------------------------------------
// Reserved-namespace guard point 2 — serve-time legacy collision check
// ---------------------------------------------------------------------------

/**
 * True if the profile's OWN filtered tool list already contains a
 * `junction__`-prefixed name (a legacy source the schema refine — guard
 * point 1 — cannot retroactively clean, since it predates the reserve or was
 * written out of band). Never widens the read: only the SAME filtered
 * listTools() the profile's real tools are built from.
 */
async function hasLegacyJunctionCollision(proxy: ProfileProxy): Promise<boolean> {
  const result = await proxy.listTools()
  if (result.isErr()) return false // listTools is always-Ok in practice; fail-safe: no collision assumed
  return result.value.some((t: ProviderTool) => t.name.startsWith("junction__"))
}

// ---------------------------------------------------------------------------
// The tool's static shape — schema + description
// ---------------------------------------------------------------------------

const RUN_CODE_TOOL_NAME = "junction__run_code" as const

const RUN_CODE_DESCRIPTION =
  "Execute JavaScript against this profile's brokered tools instead of calling them " +
  "one-by-one. Inside your code, a `tools` facade is available: `tools.search({query})` " +
  'finds tools by keyword, `tools.describe("<namespace>.<tool>")` returns a tool\'s full ' +
  "schema, and `tools.<namespace>.<tool>(args)` calls it directly and returns its result " +
  "(await it). The facade exposes ONLY the tools already visible to you in this session's " +
  "tool list — nothing broader. Prefer this over many separate tool calls when you need to " +
  "loop, filter, transform, or combine results across several calls: one run_code call with " +
  "a few tool invocations inside it costs far fewer tokens than the same work done as " +
  "separate top-level tool calls, because intermediate results never round-trip through your " +
  "context. Return a JSON-serializable value from your code (the last expression, or an " +
  "explicit `return`) — it becomes this call's result. console.log/emit() output is captured " +
  "and returned as logs. Runs sandboxed with a wall-clock timeout; every tool call your code " +
  "makes is individually audited exactly like a direct call."

const RUN_CODE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "JavaScript to execute. See the tool description for the `tools` facade.",
    },
    timeoutMs: {
      type: "number",
      description: "Optional wall-clock budget override in milliseconds (default: 30000).",
    },
  },
  required: ["code"],
  additionalProperties: false,
} as const

// ---------------------------------------------------------------------------
// buildRunCodeHandlers
// ---------------------------------------------------------------------------

/**
 * Build the synthetic `junction__run_code` handlers fragment.
 *
 * Refuses (with `onReservedNamespaceCollision`) any profile whose OWN
 * filtered tool list already contains a legacy `junction__*` name — that
 * profile gets NO synthetic tool (never silently shadowed either direction).
 * All other routed profiles still get theirs.
 */
export async function buildRunCodeHandlers(
  options: BuildRunCodeHandlersOptions,
): Promise<RunCodeHandlers> {
  const { entries, prefixed, principal, sink, onReservedNamespaceCollision } = options

  // Resolve, per entry, whether it's eligible (no legacy collision) — done
  // once at handler-build time (session-scoped, mirrors buildHandlers's own
  // "resolved once per session" contract in serve.ts), not per-call.
  const eligible: RunCodeEntry[] = []
  for (const entry of entries) {
    const collision = await hasLegacyJunctionCollision(entry.proxy)
    if (collision) {
      onReservedNamespaceCollision({ profileName: entry.profileName })
      continue
    }
    eligible.push(entry)
  }

  const wireName = (profileName: string): string =>
    prefixed ? `${profileName}__${RUN_CODE_TOOL_NAME}` : RUN_CODE_TOOL_NAME

  const byWireName = new Map<string, RunCodeEntry>()
  for (const entry of eligible) {
    byWireName.set(wireName(entry.profileName), entry)
  }

  return {
    async listTools() {
      return {
        tools: eligible.map((entry) => ({
          name: wireName(entry.profileName),
          description: RUN_CODE_DESCRIPTION,
          inputSchema: RUN_CODE_INPUT_SCHEMA,
        })),
      }
    },

    async callTool(name: string, args: Record<string, unknown>) {
      const entry = byWireName.get(name)
      if (entry === undefined) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `tool not found: ${name}` }],
        }
      }

      const codeArg = args.code
      if (typeof codeArg !== "string") {
        return {
          isError: true as const,
          content: [
            { type: "text" as const, text: "invalid tool arguments: 'code' must be a string" },
          ],
        }
      }
      const timeoutMsArg = args.timeoutMs
      const timeoutMs = typeof timeoutMsArg === "number" ? timeoutMsArg : undefined

      // Lazy-import: @junction/code-mode (QuickJS/WASM) and mcp-server's
      // safeUpstreamMessage are only loaded when run_code is actually
      // invoked — mirrors the existing lazy-import convention at every
      // serve call site (commands/mcp.ts, commands/serve.ts, providers.ts).
      const [{ runCode }, { safeUpstreamMessage }] = await Promise.all([
        import("@junction/code-mode"),
        import("@junction/mcp-server"),
      ])

      // toolInvoker: the profile's OWN proxy, structurally satisfying
      // code-mode's ToolInvoker. ResultAsync is PromiseLike<Result<...>>, not
      // a strict Promise, so each method is wrapped in an `async` function
      // (which always returns a true Promise) rather than passed directly.
      const toolInvoker = {
        listTools: async (): Promise<Result<ProviderTool[], UpstreamError>> =>
          entry.proxy.listTools(),
        callTool: async (
          toolName: string,
          toolArgs: Record<string, unknown>,
        ): Promise<Result<ToolResult, UpstreamError>> => entry.proxy.callTool(toolName, toolArgs),
      }

      const result = await runCode(codeArg, toolInvoker, {
        principal,
        sink,
        profile: entry.profileName,
        safeUpstreamMessage: (e: UpstreamError) => safeUpstreamMessage(e),
        prefixed: false, // the engine ALWAYS sees the unprefixed, single-profile facade
        opts: timeoutMs === undefined ? undefined : { timeoutMs },
      })

      if (result.isErr()) {
        // Executor-level failure (module-load-failed / dispose-failed) — an
        // internal condition, not a guest-code outcome. No host detail leaks
        // (both CodeModeError members carry only a static message).
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `code execution failed: ${result.error.kind}` }],
        }
      }

      const outcome = result.value
      if (!outcome.ok) {
        // Guest-side outcome: guest-error/timeout/memory/internal — `message`
        // is ALWAYS host-stack-free per ExecuteResultErr's contract.
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: outcome.message }],
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              value: outcome.value,
              logs: outcome.logs,
              emitted: outcome.emitted,
            }),
          },
        ],
      }
    },
  }
}

// ---------------------------------------------------------------------------
// mergeHandlers — combine the real proxied handlers with the synthetic-tool fragment
// ---------------------------------------------------------------------------

/**
 * Merge the real handlers (adaptToMcpHandlers's output) with the synthetic
 * run_code fragment. listTools concatenates both tool lists; callTool routes
 * by name — the synthetic fragment's wire name(s) are always
 * `junction__run_code` / `<profile>__junction__run_code`, which the reserved
 * namespace guarantees can never collide with a REAL (schema-valid) tool
 * name, so trying the synthetic map first (O(1)) then falling through to the
 * real handlers is safe and unambiguous.
 */
export function mergeHandlers(
  real: McpServerHandlers,
  synthetic: RunCodeHandlers,
): McpServerHandlers {
  return {
    async listTools() {
      const [realTools, syntheticTools] = await Promise.all([
        real.listTools(),
        synthetic.listTools(),
      ])
      return { tools: [...realTools.tools, ...syntheticTools.tools] }
    },
    async callTool(name: string, args: Record<string, unknown>) {
      if (name === RUN_CODE_TOOL_NAME || name.endsWith(`__${RUN_CODE_TOOL_NAME}`)) {
        return synthetic.callTool(name, args)
      }
      return real.callTool(name, args)
    },
  }
}
