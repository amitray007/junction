// SPDX-License-Identifier: AGPL-3.0-only
// createProfileProxy — aggregate, filter, and proxy tool calls across a profile's sources.
//
// ARCHITECTURE (injection):
//   resolveProvider is INJECTED by the cli (the composition root). core NEVER imports
//   CredentialStore or any DB repository — those live in core + cli. The proxy receives
//   an opaque callback that returns a ToolProvider; it never stores or inspects secrets.
//
// SECRET DISCIPLINE (security-critical):
//   The secret lives inside the ToolProvider's transport and is NEVER passed to the proxy.
//   The resolveProvider callback returns only { provider, toolNamespace, toolFilter } —
//   no secret field. Proxy output (listTools/callTool) therefore cannot leak the secret.
//
// PER-SOURCE RESILIENCE:
//   listTools: a source that fails to resolve/connect/list is SKIPPED (silent), never aborts
//   the whole catalog. callTool: failure propagates as an Err to the caller (the cli handler
//   maps it to an MCP error response without the secret).
//
// TOOL FILTER:
//   toolFilter (allow/deny) is applied to UPSTREAM (raw) tool names BEFORE namespacing.
//   allow is authoritative: if present (even empty), only listed raw names pass (allow:[] → none).
//   deny is applied after allow; listed names are removed.
//   isToolAllowed is used by BOTH list and call paths so the two cannot drift.
//
// NAMING + ≤64 GUARD:
//   For each raw provider tool: apply toolFilter on raw name → namespaceToolName → skip if Err.
//   The ≤64 guard is enforced here (not inside individual providers) — one place for all kinds.
//
// LIFECYCLE v1 — connect-per-call + close:
//   A new provider (session) is created for every listTools and callTool call by the
//   composition root (resolveProvider calls createMcpProvider → connectSource). The proxy
//   calls provider.close() in every finally block. See docs/futures/revisit-when.md.
//
// SOURCE-AGNOSTIC: zero vendor code. Works with any ToolProvider (MCP now; OpenAPI/GraphQL later).

import type { SourceRef, ToolFilter, UpstreamError } from "../index.js"
import { err, ok, type Result, ResultAsync } from "../result/index.js"
import { namespaceToolName, splitNamespacedName } from "./naming.js"
import type { ProviderTool, ToolProvider, ToolResult } from "./provider.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injected callback: SourceRef → { provider, toolNamespace, toolFilter }.
 *
 * The cli builds this from the DB + CredentialStore. The secret is embedded
 * inside the provider's transport and is NEVER part of this return value.
 */
export type ResolveProviderFn = (
  sourceRef: SourceRef,
) => ResultAsync<
  { provider: ToolProvider; toolNamespace: string; toolFilter?: ToolFilter | undefined },
  UpstreamError
>

/** Multi-source proxy for a profile's aggregated MCP tools. */
export interface ProfileProxy {
  /**
   * List all namespaced tools across all enabled sources.
   *
   * Per-source resilience: a source that fails to resolve/connect/list is silently
   * skipped; the call always returns Ok (possibly empty if all sources fail).
   * Sources are fanned out concurrently — total latency ≈ max(per-source latency).
   */
  listTools(): ResultAsync<ProviderTool[], UpstreamError>
  /**
   * Call a namespaced tool (<namespace>__<tool>).
   *
   * Splits on the FIRST "__", finds the enabled source whose toolNamespace matches
   * the prefix, then proxies the call through a fresh provider with the raw name.
   *
   * Returns Err(tool-not-found) if no source matches the namespace, or if the
   * tool is filtered out by the source's toolFilter (does not reveal it exists).
   * Returns Err(<upstream error>) if resolution, connection, or the call itself fails.
   */
  callTool(name: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError>
}

// ---------------------------------------------------------------------------
// Internal: toolFilter helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a single upstream RAW tool name passes the toolFilter.
 *
 * allow is authoritative when present: allow:[] → none pass; allow:[a,b] → only a,b pass.
 * deny is applied after allow: listed names are removed regardless of allow.
 * Absent filter → all tools pass.
 *
 * Used by BOTH list path (filter before namespacing) and callTool (check before dispatch)
 * so the two enforcement points cannot drift apart.
 */
function isToolAllowed(rawName: string, filter: ToolFilter | undefined): boolean {
  if (filter === undefined) return true

  const { allow, deny } = filter

  // allow: if present (including empty array), only names in the list pass.
  if (allow !== undefined) {
    if (!allow.includes(rawName)) return false
  }

  // deny: names in the deny list are removed (applied after allow).
  if (deny !== undefined && deny.length > 0) {
    if (deny.includes(rawName)) return false
  }

  return true
}

// ---------------------------------------------------------------------------
// createProfileProxy
// ---------------------------------------------------------------------------

/**
 * Build a ProfileProxy for a profile's sources.
 *
 * @param sources         - The profile's SourceRef list. Only enabled ones are used.
 * @param resolveProvider - Injected by the cli: maps a SourceRef to its ToolProvider +
 *   namespace. Must NOT import from the credential store here — injection keeps core pure.
 *
 * The returned proxy applies namespacing (namespaceToolName / ≤64 guard) and toolFilter
 * on top of each provider's raw output. Per-source resilience: a failing source is skipped
 * on listTools and propagated as Err on callTool.
 */
export function createProfileProxy(
  sources: SourceRef[],
  resolveProvider: ResolveProviderFn,
): ProfileProxy {
  const enabledSources = sources.filter((s) => s.enabled)

  return {
    listTools(): ResultAsync<ProviderTool[], UpstreamError> {
      const work = async (): Promise<Result<ProviderTool[], UpstreamError>> => {
        // Fan out to all sources concurrently. allSettled ensures one source's failure
        // does not abort the others, and each source's try/finally guarantees its
        // provider is closed even if a sibling rejects.
        const perSource = await Promise.allSettled(
          enabledSources.map(async (sourceRef) => {
            // Resolve the source descriptor. Failure → return empty list for this source.
            const resolveResult = await resolveProvider(sourceRef)
            if (resolveResult.isErr()) return [] as ProviderTool[]

            const { provider, toolNamespace, toolFilter } = resolveResult.value

            try {
              // List raw tools from the provider. Failure → return empty list.
              const toolsResult = await provider.listTools()
              if (toolsResult.isErr()) return [] as ProviderTool[]

              const namespaced: ProviderTool[] = []
              for (const t of toolsResult.value) {
                // Filter on RAW name first (consistent with callTool path).
                if (!isToolAllowed(t.name, toolFilter)) continue

                // Apply namespace + ≤64 guard. Skip the tool if it fails.
                const nameResult = namespaceToolName(toolNamespace, t.name)
                if (nameResult.isErr()) continue

                namespaced.push({ ...t, name: nameResult.value })
              }
              return namespaced
            } finally {
              // Always close the provider — connect-per-call lifecycle (v1).
              await provider.close()
            }
          }),
        )

        const allTools: ProviderTool[] = []
        for (const result of perSource) {
          if (result.status === "fulfilled") {
            allTools.push(...result.value)
          }
          // "rejected": unexpected throw inside the per-source logic — skip (per-source resilience)
        }

        // Always Ok: per-source resilience means partial results are valid.
        return ok(allTools)
      }
      return new ResultAsync(work())
    },

    callTool(name: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError> {
      // "execute" (not "work") to distinguish from listTools's inner function for jscpd.
      const execute = async (): Promise<Result<ToolResult, UpstreamError>> => {
        // Split on FIRST "__": namespace is unambiguous (ToolNamespaceSchema forbids "__").
        const { namespace, tool: rawName } = splitNamespacedName(name)

        // Route to the enabled source whose toolNamespace matches the prefix.
        const sourceRef = enabledSources.find((s) => s.toolNamespace === namespace)
        if (sourceRef === undefined) {
          return err({ kind: "tool-not-found", name } satisfies UpstreamError)
        }

        const resolveResult = await resolveProvider(sourceRef)
        if (resolveResult.isErr()) return err(resolveResult.error)

        const { provider, toolFilter } = resolveResult.value

        // Enforce toolFilter before dispatching — a denied tool must not be callable
        // even if the agent knows the namespaced name (e.g. bypasses listTools).
        // Returns tool-not-found (same as unknown tool) to avoid revealing the tool exists.
        if (!isToolAllowed(rawName, toolFilter)) {
          return err({ kind: "tool-not-found", name } satisfies UpstreamError)
        }

        try {
          // provider.callTool receives the RAW name (already stripped by splitNamespacedName).
          return await provider.callTool(rawName, args)
        } finally {
          // Always close the provider — connect-per-call lifecycle (v1).
          await provider.close()
        }
      }
      return new ResultAsync(execute())
    },
  }
}
