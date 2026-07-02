// SPDX-License-Identifier: AGPL-3.0-only
// Server-only probe/call helpers — the in-browser debug surface (increment 28).
// Called exclusively from probe.functions.ts createServerFn handlers.
//
// PROFILE-SCOPED: probe/call build a createProfileProxy over a SINGLE SourceRef
// (the one matching {profileId, namespace}) — the same real namespace + toolFilter
// the profile would serve through `mcp serve`. See docs/methods/28-web-probe-call.md.
//
// SECRET DISCIPLINE (load-bearing): the secret is resolved inside makeResolveProvider
// and flows only into the provider's transport. Probe returns tool names only; call
// returns upstream content + isError only. NEVER return/serialize/log the secret,
// secretRef, or a request URL.
//
// STORE FAILURE IS NULL-GRACEFUL (never a throw): a null store means credentialed
// sources resolve secret=null and fail cleanly to an error string — mirrors
// cli/src/commands/mcp.ts's `store = storeResult.isOk() ? storeResult.value : null`.
// Do NOT reuse mutations.server.ts's withReposAndStore — it throws on store failure.

import {
  createCredentialStore,
  createProfileProxy,
  createRepositories,
  getPaths,
  type Repositories,
  type SourceRef,
  splitNamespacedName,
} from "@junction/core"
import { formatUpstreamError, makeResolveProvider } from "@junction/source-runtime"

import { getDb } from "./shared.server.js"

// ---------------------------------------------------------------------------
// Error formatting — the shared exhaustive UpstreamError → string map lives in
// @junction/source-runtime (deduped inc 28). Profile-scoped surface: collapse
// tool-not-found to a GENERIC string (the proxy returns it identically for
// "no such tool" / "denied by toolFilter" / "namespaced name too long", so the
// name would leak the filter's existence/shape — non-disclosure).
// ---------------------------------------------------------------------------

function formatError(e: Parameters<typeof formatUpstreamError>[0]): string {
  return formatUpstreamError(e, { toolNotFoundMessage: () => "tool not found" })
}

// ---------------------------------------------------------------------------
// Shared resolution: (profileId, namespace) → the matching, enabled SourceRef,
// or a clean error string. Used by both probeSource and callSourceTool.
// ---------------------------------------------------------------------------

type ResolvedSource =
  | { ok: true; repos: Repositories; sourceRef: SourceRef }
  | { ok: false; error: string }

async function resolveSourceRef(profileId: string, namespace: string): Promise<ResolvedSource> {
  const db = await getDb()
  if (db === null) return { ok: false, error: "database unavailable" }

  const repos = createRepositories(db)
  const profileResult = await repos.profiles.get(profileId)
  if (profileResult.isErr()) return { ok: false, error: "profile not found" }

  const sourceRef = profileResult.value.sources.find((s) => s.toolNamespace === namespace)
  if (sourceRef === undefined) return { ok: false, error: "route not found in profile" }

  if (!sourceRef.enabled) {
    return { ok: false, error: "this route is disabled — enable it to probe" }
  }

  return { ok: true, repos, sourceRef }
}

/**
 * Build a single-source ProfileProxy for `sourceRef`, using a null-graceful
 * credential store (never throws on store failure — mirrors `junction mcp serve`).
 */
async function buildSingleSourceProxy(repos: Repositories, sourceRef: SourceRef) {
  const paths = getPaths()
  const storeResult = await createCredentialStore(paths)
  const store = storeResult.isOk() ? storeResult.value : null
  const resolveProvider = makeResolveProvider(repos, store, paths, { logPrefix: "probe" })
  return createProfileProxy([sourceRef], resolveProvider)
}

// ---------------------------------------------------------------------------
// probeSource — list the tools this route exposes through the profile
// (namespaced + toolFilter-applied, exactly as `mcp serve` would).
// ---------------------------------------------------------------------------

export type ProbeToolEntry = { namespaced: string; raw: string; description?: string }

export type ProbeSourceResult =
  | { ok: true; namespace: string; tools: ProbeToolEntry[] }
  | { ok: false; error: string }

export async function probeSource(input: {
  profileId: string
  namespace: string
}): Promise<ProbeSourceResult> {
  const resolved = await resolveSourceRef(input.profileId, input.namespace)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  const proxy = await buildSingleSourceProxy(resolved.repos, resolved.sourceRef)
  const result = await proxy.listTools()
  if (result.isErr()) return { ok: false, error: formatError(result.error) }

  const tools: ProbeToolEntry[] = result.value.map((t) => ({
    namespaced: t.name,
    raw: splitNamespacedName(t.name).tool,
    ...(t.description !== undefined ? { description: t.description } : {}),
  }))

  return { ok: true, namespace: input.namespace, tools }
}

// ---------------------------------------------------------------------------
// callSourceTool — invoke ONE namespaced tool with a JSON args object.
// ---------------------------------------------------------------------------

// ToolResult.content is typed `unknown` in core (MCP content follows spec format,
// not a fixed shape) but createServerFn's return-type serialization check rejects
// a bare `unknown`. It IS always JSON-serializable in practice (MCP content blocks
// are plain JSON), so re-type it through a recursive JSON type for the boundary.
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }

export type CallSourceToolResult =
  | { ok: true; content: JsonValue; isError: boolean }
  | { ok: false; error: string }

/** Parse argsJson to a plain JSON object. Never throws — returns an error string. */
function parseArgsJson(
  argsJson: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson === "" ? "{}" : argsJson)
  } catch (cause) {
    return { ok: false, error: `invalid JSON: ${String(cause)}` }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "arguments must be a JSON object" }
  }
  return { ok: true, args: parsed as Record<string, unknown> }
}

export async function callSourceTool(input: {
  profileId: string
  namespace: string
  toolName: string
  argsJson: string
}): Promise<CallSourceToolResult> {
  const resolved = await resolveSourceRef(input.profileId, input.namespace)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  const parsedArgs = parseArgsJson(input.argsJson)
  if (!parsedArgs.ok) return { ok: false, error: parsedArgs.error }

  const proxy = await buildSingleSourceProxy(resolved.repos, resolved.sourceRef)
  const result = await proxy.callTool(input.toolName, parsedArgs.args)
  if (result.isErr()) return { ok: false, error: formatError(result.error) }

  // ToolResult.content is `unknown` in core but is always a JSON value in practice
  // (MCP content blocks); the cast is safe and confined to this one boundary return.
  return {
    ok: true,
    content: result.value.content as JsonValue,
    isError: result.value.isError ?? false,
  }
}
