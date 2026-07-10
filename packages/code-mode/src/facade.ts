// SPDX-License-Identifier: AGPL-3.0-only
// buildFacadePlan — pure, QuickJS-free planning step: turn the invoker's
// FILTERED listTools() into a nested { namespace: { tool: ProviderTool } }
// plan the QuickJS executor installs as the guest-visible `tools` global.
//
// PURE (no QuickJS handles here) so it's unit-testable without spinning up a
// WASM context, and so the "which tools does this profile expose" question
// is answered identically regardless of runtime (QuickJS today, a future
// Deno-subprocess executor later).
//
// LAZY + NON-ENUMERABLE DISCOVERY (do-NOT: never dump the whole catalog into
// guest scope as enumerable properties — Object.keys/for-in/spread must
// throw "use tools.search()" so an agent can't dump every tool description
// into its own context window for free). The actual proxy-trap wiring (the
// part that needs QuickJS's newFunction/newObject) lives in
// quickjs-executor.ts, which drives this plan; this file only computes WHAT
// tools exist and their DESCRIPTIONS/SCHEMAS for search()/describe() — never
// re-fetches or re-derives them (they come straight from the SANITIZED +
// PINNED ProviderTool the proxy already returned — see proxy.ts's header on
// increment 32.5/32.11).

import type { ProviderTool } from "@junction/core"
import { splitNamespacedName } from "@junction/core"

/** One callable tool slot in the facade plan. */
export interface FacadeToolEntry {
  /** Wire name (`<namespace>__<tool>` or `<profile>__<namespace>__<tool>`) — what the invoker's callTool expects. */
  wireName: string
  /** Raw upstream tool name (post-namespace-split) — the facade nests under this within its namespace. */
  tool: string
  namespace: string
  description: string | undefined
  inputSchema: object
}

/** The full facade plan: namespace → tool → entry, plus a flat list for search()/describe(). */
export interface FacadePlan {
  /** Nested for `tools.<namespace>.<tool>` lookup. */
  byNamespace: Map<string, Map<string, FacadeToolEntry>>
  /** Flat for tools.search()/describe(). */
  flat: FacadeToolEntry[]
}

/**
 * Build the facade plan from the profile's FILTERED tool list.
 *
 * `prefixed`/`singleProfile` mirror parseWireName's arity contract (core's
 * audit/wire-name.ts): when `prefixed` is true (multi-profile / global-key
 * arity), each ProviderTool's `name` is `<profile>__<namespace>__<tool>` and
 * the facade nests one deeper — but v1 code-mode always runs against ONE
 * routed profile's proxy, so the profile segment is still peeled here
 * purely to recover {namespace, tool} for the SAME-profile facade; a
 * cross-profile facade is out of scope (see the method file's Do NOT list —
 * no multi-profile fan-out inside one execution).
 */
export function buildFacadePlan(tools: ProviderTool[], prefixed: boolean): FacadePlan {
  const byNamespace = new Map<string, Map<string, FacadeToolEntry>>()
  const flat: FacadeToolEntry[] = []

  for (const t of tools) {
    const wireName = t.name
    const unprefixed = prefixed ? stripProfilePrefix(t.name) : t.name
    const { namespace, tool } = splitNamespacedName(unprefixed)
    if (namespace === "") continue // malformed name — skip defensively, never throw from a plan-build

    const entry: FacadeToolEntry = {
      wireName,
      tool,
      namespace,
      description: t.description,
      inputSchema: t.inputSchema,
    }

    let nsMap = byNamespace.get(namespace)
    if (!nsMap) {
      nsMap = new Map()
      byNamespace.set(namespace, nsMap)
    }
    nsMap.set(tool, entry)
    flat.push(entry)
  }

  return { byNamespace, flat }
}

/** Peel `<profile>__` off a prefixed wire name (charset contract: profile names carry no `_`). */
function stripProfilePrefix(name: string): string {
  const idx = name.indexOf("__")
  if (idx === -1) return name
  return name.slice(idx + 2)
}

/** Search result shape served by `tools.search({query})` — sanitized description only, never raw upstream. */
export interface SearchResult {
  namespace: string
  tool: string
  description: string | undefined
}

/** Case-insensitive substring match over namespace/tool/description — pure, no I/O. */
export function searchFacade(plan: FacadePlan, query: string): SearchResult[] {
  const q = query.toLowerCase()
  return plan.flat
    .filter(
      (e) =>
        e.namespace.toLowerCase().includes(q) ||
        e.tool.toLowerCase().includes(q) ||
        (e.description?.toLowerCase().includes(q) ?? false),
    )
    .map((e) => ({ namespace: e.namespace, tool: e.tool, description: e.description }))
}

/**
 * Static guidance on what `await tools.<namespace>.<tool>(args)` actually
 * returns (33f — the facade unwraps the raw MCP content envelope before the
 * guest ever sees it): identical for every tool regardless of provider kind
 * (mcp/openapi/graphql/http/cli), so it's a constant rather than something
 * describeFacadeTool derives per entry — see quickjs-executor.ts's
 * unwrapToolResult for the exact per-kind unwrap rules.
 */
export const RESULT_SHAPE_GUIDANCE =
  "A JSON response body resolves to the parsed value (object/array/etc) — never the raw " +
  "MCP content envelope. Plain-text output resolves to a string. A multi-part response " +
  "resolves to an array. A failed call (upstream error, or the tool's own response " +
  "signaling failure) throws a JS exception instead of resolving."

/** Describe result shape served by `tools.describe.tool({path})` — path is `<namespace>.<tool>`. */
export interface DescribeResult {
  namespace: string
  tool: string
  description: string | undefined
  inputSchema: object
  /** See RESULT_SHAPE_GUIDANCE — what calling this tool actually returns. */
  resultShape: string
}

export function describeFacadeTool(plan: FacadePlan, path: string): DescribeResult | undefined {
  const dot = path.indexOf(".")
  if (dot === -1) return undefined
  const namespace = path.slice(0, dot)
  const tool = path.slice(dot + 1)
  const entry = plan.byNamespace.get(namespace)?.get(tool)
  if (!entry) return undefined
  return {
    namespace,
    tool,
    description: entry.description,
    inputSchema: entry.inputSchema,
    resultShape: RESULT_SHAPE_GUIDANCE,
  }
}
