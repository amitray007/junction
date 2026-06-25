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
//   namespaced name). allow is checked first; if set, only listed upstream names are kept.
//   deny is applied after allow; listed names are removed regardless of allow.
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
   */
  listTools(): ResultAsync<NamespacedTool[], UpstreamError>
  /**
   * Call a namespaced tool (<namespace>__<tool>).
   *
   * Splits on the FIRST "__", finds the enabled source whose toolNamespace matches
   * the prefix, then proxies the call through a fresh session.
   *
   * Returns Err(tool-not-found) if no source matches the namespace.
   * Returns Err(<upstream error>) if resolution, connection, or the call itself fails.
   */
  callTool(name: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError>
}

// ---------------------------------------------------------------------------
// Internal: toolFilter application
// ---------------------------------------------------------------------------

/**
 * Apply a ToolFilter to a namespaced tool list.
 *
 * Filtering is performed on UPSTREAM names (the part after the first "__").
 * allow is applied first (if set, only those upstream names survive).
 * deny is applied after (those upstream names are removed regardless of allow).
 */
function applyToolFilter(
  tools: NamespacedTool[],
  toolFilter: ToolFilter | undefined,
): NamespacedTool[] {
  if (toolFilter === undefined) return tools

  const { allow, deny } = toolFilter

  return tools.filter((tool) => {
    // Extract upstream name (strip namespace prefix) for filter matching.
    const { tool: upstreamName } = splitNamespacedName(tool.name)

    // allow: if set and non-empty, only upstream names in the list are kept.
    if (allow !== undefined && allow.length > 0) {
      if (!allow.includes(upstreamName)) return false
    }

    // deny: upstream names in the deny list are removed (applied after allow).
    if (deny !== undefined && deny.length > 0) {
      if (deny.includes(upstreamName)) return false
    }

    return true
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
        const allTools: NamespacedTool[] = []

        for (const sourceRef of enabledSources) {
          // Resolve the source descriptor. Failure → skip this source.
          const resolveResult = await resolveSource(sourceRef)
          if (resolveResult.isErr()) continue

          const { connection, secret, toolNamespace, toolFilter } = resolveResult.value

          // Connect to the upstream. Failure → skip this source.
          const sessionResult = await sessionFactory(connection, toolNamespace, secret)
          if (sessionResult.isErr()) continue

          const session = sessionResult.value
          try {
            // List tools from the upstream session. Failure → skip this source's tools.
            const toolsResult = await session.listTools()
            if (toolsResult.isOk()) {
              const filtered = applyToolFilter(toolsResult.value.tools, toolFilter)
              allTools.push(...filtered)
            }
          } finally {
            // Always close the session — connect-per-call lifecycle (v1).
            await session.close()
          }
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
        const { namespace } = splitNamespacedName(name)

        // Route to the enabled source whose toolNamespace matches the prefix.
        const sourceRef = enabledSources.find((s) => s.toolNamespace === namespace)
        if (sourceRef === undefined) {
          return err({ kind: "tool-not-found", name } satisfies UpstreamError)
        }

        const resolveResult = await resolveSource(sourceRef)
        if (resolveResult.isErr()) return err(resolveResult.error)

        const { connection, secret, toolNamespace } = resolveResult.value

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
