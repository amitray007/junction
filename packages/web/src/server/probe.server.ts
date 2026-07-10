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
  createFileToolPinStore,
  createProfileProxy,
  createRepositories,
  getPaths,
  type Platform,
  type Repositories,
  type SourceRef,
  splitNamespacedName,
} from "@junction/core"
import {
  buildProvider,
  formatUpstreamError,
  makeResolveProvider,
  resolveCredentialSecret,
  toResolvedSecret,
} from "@junction/source-runtime"

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
  // Tool-poisoning mitigation (increment 32.5) + hash-pinning / rug-pull detection
  // (increment 32.11): sanitize and TOFU pin-comparison are always applied inside
  // createProfileProxy; onDescriptionDrift only SURFACES either signal, discriminated by
  // info.reason ("sanitized" | "pin-drift") as a structured warn — metadata only, never
  // the (possibly-injected) description text, never old/new hashes. Same warn channel
  // (console.warn) this probe surface already used pre-32.11.
  const toolPinStore = createFileToolPinStore(paths)
  return createProfileProxy(
    [sourceRef],
    resolveProvider,
    (info) => {
      console.warn({
        event: info.reason === "pin-drift" ? "tool_pin_drift" : "description_sanitized",
        namespace: info.namespace,
        tool: info.tool,
        strippedSuspicious: info.strippedSuspicious,
        truncated: info.truncated,
        reason: info.reason,
      })
    },
    toolPinStore,
  )
}

// ---------------------------------------------------------------------------
// probeSource — list the tools this route exposes through the profile
// (namespaced + toolFilter-applied, exactly as `mcp serve` would).
// ---------------------------------------------------------------------------

/**
 * `params` (increment 30.10) is an optional short summary of a tool's
 * inputSchema, derived server-side by summarizeParams — NEVER the raw
 * inputSchema itself (which could carry upstream-authored implementation
 * detail not meant as a public contract). Additive: absent on every
 * pre-30.10 caller, present when the caller (probeSurface) computes it.
 */
export type ProbeToolEntry = {
  namespaced: string
  raw: string
  description?: string
  params?: string
}

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

// ---------------------------------------------------------------------------
// probeSurface — list a catalog surface's tools for ONE (platform, credential)
// connection, PLATFORM-scoped (increment 30.10 — no profile/namespace exists
// yet for a surface the user hasn't wired into a profile).
//
// DECIDED path (method file §3c, feasibility-confirmed): build the provider
// via buildProvider DIRECTLY — NOT createProfileProxy/makeResolveProvider.
// makeResolveProvider (resolve-provider.ts) hard-restricts to mcp/openapi and
// silently skips graphql/http/cli — using it here would make 3 of GitHub's 5
// surfaces return an empty tool list with no error, which is worse than an
// honest "couldn't list tools". buildProvider handles all 5 kinds.
//
// Exact precedent: packages/cli/src/commands/debug.ts's runProbe (resolve
// secret → buildProvider → listTools → close in finally). This mirrors that,
// returning a value instead of writing to stdout/stderr.
// ---------------------------------------------------------------------------

export type ToolListResult =
  | { status: "ok"; tools: ProbeToolEntry[] }
  | { status: "error"; reason: string }

/**
 * Summarize a JSON-Schema-shaped inputSchema into a short param list for
 * display — NEVER the raw schema (§3c format rule, doc-review M2).
 * Required params first (each `*`-suffixed), then optional, comma-joined.
 * Capped at ~8 total with a `…` overflow marker. Object/array-typed params
 * are named only (no nested expansion). Returns undefined when the schema
 * has no `properties` to summarize.
 */
export function summarizeParams(inputSchema: object): string | undefined {
  const schema = inputSchema as { properties?: unknown; required?: unknown }
  if (typeof schema.properties !== "object" || schema.properties === null) return undefined

  const propertyNames = Object.keys(schema.properties as Record<string, unknown>)
  if (propertyNames.length === 0) return undefined

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  )

  const requiredNames = propertyNames.filter((n) => required.has(n))
  const optionalNames = propertyNames.filter((n) => !required.has(n))
  const ordered = [...requiredNames, ...optionalNames]

  const CAP = 8
  const shown = ordered.slice(0, CAP).map((n) => (required.has(n) ? `${n}*` : n))
  if (ordered.length > CAP) shown.push("…")

  return shown.join(", ")
}

/** Look up a platform row by id, or a clean ToolListResult error — never throws. */
async function lookupPlatform(
  repos: Repositories,
  platformId: string,
): Promise<{ ok: true; platform: Platform } | { ok: false; result: ToolListResult }> {
  const platformResult = await repos.platforms.get(platformId)
  if (platformResult.isErr()) {
    return { ok: false, result: { status: "error", reason: "platform not found" } }
  }
  return { ok: true, platform: platformResult.value }
}

export async function probeSurface(input: {
  platformId: string
  credentialId?: string
}): Promise<ToolListResult> {
  const db = await getDb()
  if (db === null) return { status: "error", reason: "database unavailable" }
  const repos = createRepositories(db)

  const platformLookup = await lookupPlatform(repos, input.platformId)
  if (!platformLookup.ok) return platformLookup.result
  const { platform } = platformLookup

  const paths = getPaths()

  // Two graceful arms (method file §3c): a lost/cleared secret resolves
  // {secret: null} (no throw); a store/db failure resolves an Err — both map
  // to an honest error result here, never a throw.
  //
  // DELIBERATE DIVERGENCE from §3c's literal text: a connection with NO
  // credentialId (input.credentialId undefined) is NOT special-cased into an
  // error/"not connected" here — it flows through resolveCredentialSecret's
  // no-credential fast path (secret: null) and buildProvider is still
  // attempted. This is correct, not an oversight: a credential-less
  // connection represents a genuinely PUBLIC/no-auth surface (e.g. a public
  // GraphQL API), which can have real, listable tools — reporting it as an
  // error would be dishonest. Review-accepted (2026-07-06).
  const secretResult = await resolveCredentialSecret(repos, paths, input.credentialId)
  if (secretResult.isErr()) {
    const reason =
      secretResult.error.kind === "db"
        ? "database unavailable"
        : "credential store unavailable — couldn't resolve the secret"
    return { status: "error", reason }
  }
  const { secret, kind } = secretResult.value

  const providerResult = await buildProvider(platform, toResolvedSecret(secret, kind), paths)
  if (providerResult.isErr()) {
    return { status: "error", reason: formatUpstreamError(providerResult.error) }
  }
  const provider = providerResult.value

  try {
    const toolsResult = await provider.listTools()
    if (toolsResult.isErr()) {
      return { status: "error", reason: formatUpstreamError(toolsResult.error) }
    }

    // Raw, un-namespaced names — no profile namespace exists on this path.
    const tools: ProbeToolEntry[] = toolsResult.value.map((t) => {
      const params = summarizeParams(t.inputSchema)
      return {
        namespaced: t.name,
        raw: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(params !== undefined ? { params } : {}),
      }
    })

    // An empty-but-ok tool list is the HONEST "no tools available" case (e.g.
    // GitHub's http surface) — never converted into an error here.
    return { status: "ok", tools }
  } finally {
    // Always close the provider — a leaked connection/timer is the inc-11
    // hang gotcha (mandatory, mirrors cli debug.ts's runProbe).
    await provider.close()
  }
}
