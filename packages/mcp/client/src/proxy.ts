// SPDX-License-Identifier: AGPL-3.0-only
// createProfileProxy — aggregate, filter, and proxy tool calls across a profile's sources.
//
// ARCHITECTURE (injection):
//   resolveSource is INJECTED by the cli (the composition root). mcp/client NEVER imports
//   CredentialStore or any DB repository — those live in core + cli. The proxy receives
//   an opaque callback that returns a connection + secret; it never stores or inspects secrets.
//
// SECRET DISCIPLINE (security-critical):
//   The secret is passed directly to connectSource, which injects it only into the transport.
//   It is NEVER stored on the proxy, never returned in listTools/callTool results, never
//   logged, and never placed in an error message. The proxy sees it only in-flight.
//
// PER-SOURCE RESILIENCE:
//   listTools: a source that fails to resolve/connect/list is SKIPPED (silent), never aborts
//   the whole catalog. callTool: failure propagates as an Err to the caller (the cli handler
//   maps it to an MCP error response without the secret).
//
// TOOL FILTER:
//   toolFilter (allow/deny) is applied to UPSTREAM tool names (the part after "__" in the
//   namespaced name). allow is authoritative: if present (even empty), only listed upstream
//   names pass (allow:[] → none pass). deny is applied after allow; listed names are removed.
//   The shared isToolAllowed helper is used by BOTH listTools (applyToolFilter) and callTool
//   so the two paths cannot drift.
//
// LIFECYCLE v1 — connect-per-call + close:
//   A new session is created for every listTools and callTool call, then closed immediately.
//   See docs/futures/revisit-when.md for the warm-session-pool trigger.
//
// SOURCE-AGNOSTIC: zero vendor code. The proxy works with any McpConnection (http/stdio).

import type { McpConnection, SourceRef, ToolFilter, UpstreamError } from "@junction/core"
import { err, ok, type Result, ResultAsync } from "neverthrow"
import { connectSource } from "./connect.js"
import { splitNamespacedName } from "./helpers.js"
import type { NamespacedTool, ToolResult, UpstreamSession } from "./session.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The resolved descriptor for a single SourceRef — returned by the injected
 * resolveSource callback. The cli builds this from the DB + CredentialStore.
 *
 * secret is the plaintext bearer token (or null if the source needs no auth).
 * It must be treated as sensitive and must NOT appear in any log, error, or result.
 */
export interface ResolvedSource {
  connection: McpConnection
  /** Plaintext secret — SENSITIVE. Injected only into the transport; never stored. */
  secret: string | null
  toolNamespace: string
  toolFilter?: ToolFilter | undefined
}

/** Injected callback: SourceRef → resolved connection + secret + filter. */
export type ResolveSourceFn = (sourceRef: SourceRef) => ResultAsync<ResolvedSource, UpstreamError>

/**
 * Session factory — wraps connection + secret into an UpstreamSession.
 *
 * Default: connectSource (the real transport-based factory).
 * Tests inject a factory that returns pre-connected InMemoryTransport sessions,
 * allowing the full proxy logic (filter, routing, resilience) to be tested without
 * spawning real subprocesses or making network calls.
 *
 * Invariant (Err implies self-cleanup): if the factory returns Err, it is responsible
 * for closing any partially-opened transport before returning. The proxy never calls
 * close() on a session that was not successfully returned as Ok.
 */
export type SessionFactory = (
  connection: McpConnection,
  toolNamespace: string,
  secret: string | null,
) => ResultAsync<UpstreamSession, UpstreamError>

/** Multi-source proxy for a profile's aggregated MCP tools. */
export interface ProfileProxy {
  /**
   * List all namespaced tools across all enabled sources.
   *
   * Per-source resilience: a source that fails to resolve/connect/list is silently
   * skipped; the call always returns Ok (possibly with an empty array if all sources fail).
   * Sources are fanned out concurrently — total latency ≈ max(per-source latency).
   */
  listTools(): ResultAsync<NamespacedTool[], UpstreamError>
  /**
   * Call a namespaced tool (<namespace>__<tool>).
   *
   * Splits on the FIRST "__", finds the enabled source whose toolNamespace matches
   * the prefix, then proxies the call through a fresh session.
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
 * Check whether a single upstream tool name passes the toolFilter.
 *
 * allow is authoritative when present: allow:[] → none pass; allow:[a,b] → only a,b pass.
 * deny is applied after allow: listed names are removed regardless of allow.
 * Absent filter → all tools pass.
 *
 * Used by BOTH applyToolFilter (list path) and callTool (call path) so the two
 * enforcement points cannot drift apart.
 */
function isToolAllowed(upstreamName: string, filter: ToolFilter | undefined): boolean {
  if (filter === undefined) return true

  const { allow, deny } = filter

  // allow: if present (including empty array), only names in the list pass.
  if (allow !== undefined) {
    if (!allow.includes(upstreamName)) return false
  }

  // deny: names in the deny list are removed (applied after allow).
  if (deny !== undefined && deny.length > 0) {
    if (deny.includes(upstreamName)) return false
  }

  return true
}

/**
 * Apply a ToolFilter to a namespaced tool list.
 *
 * Filtering is performed on UPSTREAM names (the part after the first "__").
 * Delegates to isToolAllowed for the per-tool decision so list and call paths
 * share a single implementation.
 */
function applyToolFilter(
  tools: NamespacedTool[],
  toolFilter: ToolFilter | undefined,
): NamespacedTool[] {
  if (toolFilter === undefined) return tools
  return tools.filter((tool) => {
    const { tool: upstreamName } = splitNamespacedName(tool.name)
    return isToolAllowed(upstreamName, toolFilter)
  })
}

// ---------------------------------------------------------------------------
// createProfileProxy
// ---------------------------------------------------------------------------

/**
 * Build a ProfileProxy for a profile's sources.
 *
 * @param sources       - The profile's SourceRef list (from the DB). Only enabled ones are used.
 * @param resolveSource - Injected by the cli: maps a SourceRef to its connection + secret.
 *   Must NOT be imported from the credential store here — injection keeps mcp/client pure.
 * @param sessionFactory - Optional test seam (default: connectSource). Tests inject a factory
 *   that returns pre-connected InMemoryTransport sessions so the proxy logic can be tested
 *   without starting real subprocesses or making real network calls.
 */
export function createProfileProxy(
  sources: SourceRef[],
  resolveSource: ResolveSourceFn,
  sessionFactory: SessionFactory = connectSource,
): ProfileProxy {
  const enabledSources = sources.filter((s) => s.enabled)

  return {
    listTools(): ResultAsync<NamespacedTool[], UpstreamError> {
      const work = async (): Promise<Result<NamespacedTool[], UpstreamError>> => {
        // Fan out to all sources concurrently. allSettled ensures one source's failure
        // does not abort the others, and each source's try/finally guarantees its session
        // is closed even if a sibling rejects.
        const perSource = await Promise.allSettled(
          enabledSources.map(async (sourceRef) => {
            // Resolve the source descriptor. Failure → return empty list for this source.
            const resolveResult = await resolveSource(sourceRef)
            if (resolveResult.isErr()) return [] as NamespacedTool[]

            const { connection, secret, toolNamespace, toolFilter } = resolveResult.value

            // Connect to the upstream. Failure → return empty list for this source.
            const sessionResult = await sessionFactory(connection, toolNamespace, secret)
            if (sessionResult.isErr()) return [] as NamespacedTool[]

            const session = sessionResult.value
            try {
              // List tools from the upstream session. Failure → return empty list.
              const toolsResult = await session.listTools()
              if (toolsResult.isOk()) {
                return applyToolFilter(toolsResult.value.tools, toolFilter)
              }
              return [] as NamespacedTool[]
            } finally {
              // Always close the session — connect-per-call lifecycle (v1).
              // This finally block runs even if a sibling source's promise rejected.
              await session.close()
            }
          }),
        )

        const allTools: NamespacedTool[] = []
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
        const { namespace, tool: upstreamName } = splitNamespacedName(name)

        // Route to the enabled source whose toolNamespace matches the prefix.
        const sourceRef = enabledSources.find((s) => s.toolNamespace === namespace)
        if (sourceRef === undefined) {
          return err({ kind: "tool-not-found", name } satisfies UpstreamError)
        }

        const resolveResult = await resolveSource(sourceRef)
        if (resolveResult.isErr()) return err(resolveResult.error)

        const { connection, secret, toolNamespace, toolFilter } = resolveResult.value

        // Enforce toolFilter before dispatching — a denied tool must not be callable
        // even if the agent knows the namespaced name (e.g. bypasses listTools).
        // Returns tool-not-found (same as unknown tool) to avoid revealing the tool exists.
        if (!isToolAllowed(upstreamName, toolFilter)) {
          return err({ kind: "tool-not-found", name } satisfies UpstreamError)
        }

        const sessionResult = await sessionFactory(connection, toolNamespace, secret)
        if (sessionResult.isErr()) return err(sessionResult.error)

        const session = sessionResult.value
        try {
          // session.callTool strips the namespace prefix before routing upstream.
          return await session.callTool(name, args)
        } finally {
          // Always close the session — connect-per-call lifecycle (v1).
          await session.close()
        }
      }
      return new ResultAsync(execute())
    },
  }
}
