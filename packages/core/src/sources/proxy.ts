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
// FILTER-BEFORE-CONNECT (security + leak-free):
//   callTool checks sourceRef.toolFilter BEFORE resolveProvider. resolveProvider eagerly
//   connects (spawns child / opens a session), so a denied tool is rejected without ever
//   connecting — no spawned child, no open transport, no event-loop leak.
//   listTools skips sources whose allow:[] provably exposes nothing (no connect needed);
//   non-empty allow or deny still requires listing actual tool names, so those still connect.
//
// NAMING + ≤64 GUARD:
//   For each raw provider tool: apply toolFilter on raw name → namespaceToolName → skip if Err.
//   The ≤64 guard is enforced here (not inside individual providers) — one place for all kinds.
//   callTool replicates the same check so list and call agree on the skip set.
//
// LIFECYCLE v1 — connect-per-call + close:
//   A new provider (session) is created for every listTools and callTool call by the
//   composition root (resolveProvider calls createMcpProvider → connectSource). The proxy
//   calls provider.close() in every finally block. See docs/futures/revisit-when.md.
//
// SOURCE-AGNOSTIC: zero vendor code. Works with any ToolProvider (MCP now; OpenAPI/GraphQL later).
//
// HASH-PINNING (increment 32.11):
//   listTools optionally hashes each tool's SANITIZED description + inputSchema and compares
//   it to a prior pin (TOFU + warn-and-serve — see tool-pins.ts). The ToolPinStore is INJECTED
//   and OPTIONAL, same DI shape as resolveProvider: its absence is a complete no-op (zero
//   behavior change, no reads/writes). callTool never touches pins — descriptions/schemas
//   never flow through the call path.

import { sha256Hex } from "../api-keys/hash.js"
import type { SourceRef, ToolFilter, UpstreamError } from "../index.js"
import { err, ok, type Result, ResultAsync } from "../result/index.js"
import { namespaceToolName, splitNamespacedName } from "./naming.js"
import type { ProviderTool, ToolProvider, ToolResult } from "./provider.js"
import { sanitizeDescription } from "./sanitize-description.js"
import { type PinChange, pinKeyString, type ToolPinStore } from "./tool-pins.js"

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

/**
 * Injected callback (increment 32.5, extended 32.11): fired from listTools for two
 * DISTINCT reasons, discriminated by `reason`:
 *
 *   - "sanitized"  (increment 32.5, original behavior) — a tool DESCRIPTION was sanitized
 *     in a way that indicates a real injection attempt: a control/format character was
 *     stripped, or the description was truncated for excessive length. NOT fired for
 *     cosmetic-only changes (NFKC normalization or whitespace collapse alone) — that would
 *     drown the real signal on nearly every listTools call for many honest, non-English or
 *     multi-line sources.
 *   - "pin-drift"  (increment 32.11) — a previously-pinned tool's SANITIZED description +
 *     inputSchema hash no longer matches the recorded pin ("rug pull" detection, TOFU +
 *     warn-and-serve v1 — see tool-pins.ts). Fired once per changed hash on a BEST-EFFORT
 *     basis: the pin is updated to the new hash by the batch write at the end of the pass,
 *     so a subsequent identical listing normally does not re-fire — but if that write FAILS
 *     (surfaced via OnPinStoreWarningFn below), the pin keeps the old hash and the same
 *     change re-fires on the next listing until a write succeeds.
 *
 * METADATA ONLY: never passed the raw or sanitized description text, nor the old/new hash —
 * the (possibly-injected) text must never reach a log, and hashes alone are enough to prove
 * a change occurred without needing to diff/reveal content. Same injection pattern as
 * resolveProvider; the pure proxy never imports a logger.
 *
 * `namespace` on a "pin-drift" fire is OPERATOR CONTEXT only (which mount surfaced the
 * drift) — the pin itself is keyed by `(platformId, rawName)`, not the namespace (see
 * tool-pins.ts's file header for why).
 */
export type OnDescriptionDriftFn = (info: {
  namespace: string
  tool: string
  strippedSuspicious: boolean
  truncated: boolean
  reason: "sanitized" | "pin-drift"
}) => void

/**
 * Injected callback (increment 32.11 review-gate fix): fired when the pin STORE itself is
 * degraded — a corrupt/unreadable pins file on read, or a failed/refused batch write. This
 * is deliberately a separate channel from OnDescriptionDriftFn: a store-health problem has
 * no per-tool identity and must not masquerade as a tool finding, but it also must not be
 * SILENT (a corrupt pins file or a persistently failing write would otherwise disable
 * rug-pull detection forever with no operator signal).
 *
 * Fired at most once per listTools pass per op ("read" | "write"). `detail` is a
 * content-free error CODE/kind (e.g. "parse-failed", "refused-corrupt-file", an errno like
 * "EACCES") — never file content or description text.
 */
export type OnPinStoreWarningFn = (info: { op: "read" | "write"; detail: string }) => void

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
   * Returns Err(tool-not-found) if no source matches the namespace (genuinely unknown).
   * Returns Err(tool-denied) if the tool is filtered out by the source's toolFilter —
   * distinct internally for audit purposes, but the agent-facing message (mcp-server's
   * safeUpstreamMessage) collapses it to the same opaque text as tool-not-found so a
   * filtered tool's existence is never revealed.
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
// Hash-pinning helpers (increment 32.11)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization — sorts object keys recursively so the same logical
 * value always serializes identically regardless of upstream key order. Mirrors the
 * sorted-keys idiom in audit/redact.ts's hashArgs; not shared because that helper is
 * args-shaped (Record<string, unknown> only) while this must also walk arrays and the
 * description string. Arrays keep their order (order is semantically meaningful there);
 * only object keys are sorted.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * Hash a tool's identity for pinning: the SANITIZED description (never raw — a raw
 * injection payload must never influence a persisted hash's provenance) + inputSchema.
 * `description` is the value ALREADY assigned to the outgoing ProviderTool (post-sanitize),
 * so this is called after sanitizeDescription, never before.
 *
 * LOCK-STEP COUPLING (do not let these drift): the hash covers exactly description +
 * inputSchema because that is ALL the mcp session forwards today — mcp/client session.ts's
 * listTools maps each upstream tool to only { name, description, inputSchema }, stripping
 * every other field. If the session (or any other provider) ever starts forwarding more
 * agent-visible tool metadata (annotations, outputSchema, title, …), the pin hash MUST grow
 * to cover it in the same change — otherwise a rug pull hidden in the new field goes
 * undetected.
 */
function hashToolIdentity(description: string | undefined, inputSchema: object): string {
  return sha256Hex(stableStringify({ description: description ?? null, inputSchema }))
}

// ---------------------------------------------------------------------------
// createProfileProxy
// ---------------------------------------------------------------------------

/**
 * Build a ProfileProxy for a profile's sources.
 *
 * @param sources             - The profile's SourceRef list. Only enabled ones are used.
 * @param resolveProvider     - Injected by the cli: maps a SourceRef to its ToolProvider +
 *   namespace. Must NOT import from the credential store here — injection keeps core pure.
 * @param onDescriptionDrift  - Optional (increment 32.5, extended 32.11): fired from listTools
 *   only, for a sanitize-drift signal (`reason: "sanitized"`) or a hash-pin mismatch
 *   (`reason: "pin-drift"`). Absent callback → sanitize/pinning are still applied, just not
 *   surfaced (no-op, never throws).
 * @param toolPinStore        - Optional (increment 32.11): TOFU hash-pin store, injected the
 *   same way resolveProvider is (proxy.ts does NO file I/O itself). Absent store → NO pinning
 *   at all — zero behavior change from pre-32.11 (no reads, no writes, no drift fires for
 *   "pin-drift"). See tool-pins.ts for the store's shape and on-disk format.
 * @param onPinStoreWarning   - Optional (increment 32.11 review-gate fix): fired at most once
 *   per listTools pass per op when the pin store itself is degraded (corrupt file on read,
 *   failed/refused batch write) — see OnPinStoreWarningFn. Absent callback → the store still
 *   fails open, just without the operator signal (tests/paths that opt out).
 *
 * The returned proxy applies namespacing (namespaceToolName / ≤64 guard), toolFilter,
 * description sanitization (increment 32.5 — tool-poisoning mitigation), and hash-pinning
 * (increment 32.11 — rug-pull detection) on top of each provider's raw output. Per-source
 * resilience: a failing source is skipped on listTools and propagated as Err on callTool.
 * callTool needs no sanitization or pinning — descriptions/schemas never flow through the
 * call path.
 */
export function createProfileProxy(
  sources: SourceRef[],
  resolveProvider: ResolveProviderFn,
  onDescriptionDrift?: OnDescriptionDriftFn,
  toolPinStore?: ToolPinStore,
  onPinStoreWarning?: OnPinStoreWarningFn,
): ProfileProxy {
  const enabledSources = sources.filter((s) => s.enabled)

  return {
    listTools(): ResultAsync<ProviderTool[], UpstreamError> {
      const work = async (): Promise<Result<ProviderTool[], UpstreamError>> => {
        // Load the pin map ONCE per listTools call (read-once/batch-write — tool-pins.ts's
        // documented contract). Absent store → skip entirely (zero behavior change: no reads,
        // no writes, no "pin-drift" fires below).
        //
        // FAIL-OPEN ON STORE ERRORS, NEVER SILENT: a corrupt/unreadable pins file resolves to
        // an empty map with `warning: true` (tool-pins.ts never throws) — pinning degrades to
        // "every tool looks newly-seen" for this pass and listing proceeds. The degraded state
        // is surfaced through onPinStoreWarning (once per pass per op), NOT through
        // onDescriptionDrift: a store-health problem has no per-tool identity and must not
        // masquerade as a tool finding — but it must reach the operator, because a corrupt
        // file or persistently failing write would otherwise disable rug-pull detection
        // forever with no signal. Note the write side does NOT self-heal over corruption:
        // putMany REFUSES to overwrite a file it couldn't parse (see tool-pins.ts).
        const existingPins = toolPinStore ? await toolPinStore.getAll() : undefined
        if (existingPins?.warning && onPinStoreWarning) {
          onPinStoreWarning({ op: "read", detail: existingPins.detail ?? "read-failed" })
        }
        const pinChanges: PinChange[] = []
        const nowIso = new Date().toISOString()

        // Fan out to all sources concurrently. allSettled ensures one source's failure
        // does not abort the others, and each source's try/finally guarantees its
        // provider is closed even if a sibling rejects.
        const perSource = await Promise.allSettled(
          enabledSources.map(async (sourceRef) => {
            // ALLOW:[] SHORT-CIRCUIT: if allow is present and empty the source provably
            // exposes nothing — skip connecting entirely. A non-empty allow or a deny list
            // still requires listing actual upstream names to apply the filter, so connect.
            if (
              sourceRef.toolFilter?.allow !== undefined &&
              sourceRef.toolFilter.allow.length === 0
            ) {
              return [] as ProviderTool[]
            }

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

                // TOOL-POISONING MITIGATION (increment 32.5): sanitize the description —
                // the ONE point every agent-visible tool description flows through, for
                // every source kind. Surface drift ONLY when it's a real injection signal
                // (strippedSuspicious or truncated), never for cosmetic-only changes.
                let description = t.description
                if (description !== undefined) {
                  const sanitized = sanitizeDescription(description)
                  description = sanitized.text
                  if ((sanitized.strippedSuspicious || sanitized.truncated) && onDescriptionDrift) {
                    onDescriptionDrift({
                      namespace: toolNamespace,
                      tool: t.name,
                      strippedSuspicious: sanitized.strippedSuspicious,
                      truncated: sanitized.truncated,
                      reason: "sanitized",
                    })
                  }
                }

                // HASH-PINNING / RUG-PULL DETECTION (increment 32.11): compute the pin hash
                // over the SANITIZED description (never raw) + inputSchema. Only when a store
                // was injected — otherwise this is a complete no-op (no hashing, no compare).
                // Keyed by the stable upstream identity (platformId, rawName) — NOT the
                // profile-local namespace, which is only unique per profile while the pins
                // file is global (two profiles binding the same namespace to different
                // platforms would ping-pong one namespace-keyed pin into perpetual false
                // drift). The namespace goes into the WARN payload only (operator context).
                if (toolPinStore && existingPins) {
                  const key = { platformId: sourceRef.platformId, rawName: t.name }
                  const hash = hashToolIdentity(description, t.inputSchema)
                  const existing = existingPins.pins.get(pinKeyString(key))
                  if (existing === undefined) {
                    // TOFU: first sighting — record silently, no drift fire.
                    pinChanges.push({ key, hash, now: nowIso })
                  } else if (existing.hash !== hash) {
                    // Rug pull: a previously-pinned tool's identity changed. Warn-and-serve —
                    // the tool below is still pushed to `namespaced` (v1 never blocks).
                    pinChanges.push({ key, hash, now: nowIso })
                    if (onDescriptionDrift) {
                      onDescriptionDrift({
                        namespace: toolNamespace,
                        tool: t.name,
                        strippedSuspicious: false,
                        truncated: false,
                        reason: "pin-drift",
                      })
                    }
                  }
                  // existing.hash === hash: unchanged — no write, no fire (proof-of-done #3).
                }

                namespaced.push({ ...t, name: nameResult.value, description })
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

        // ONE putMany for all new/changed pins across every source (tool-pins.ts's documented
        // batch-write contract — proof-of-done #3: unchanged tools never trigger a rewrite,
        // enforced by pinChanges only containing new/changed entries). Fire-and-handled here
        // (not fire-and-forget): a write failure fails OPEN — it must never fail the listing
        // that triggered it, which is why putMany itself never throws/rejects — but it is
        // SURFACED via onPinStoreWarning (a persistently failing write, e.g. read-only home
        // or a refused-corrupt-file, would otherwise silently disable pinning forever, and
        // pin-drift would re-fire on every listing with no visible cause).
        if (toolPinStore && pinChanges.length > 0) {
          const putResult = await toolPinStore.putMany(pinChanges)
          if (putResult.warning && onPinStoreWarning) {
            onPinStoreWarning({ op: "write", detail: putResult.detail ?? "write-failed" })
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
        const { namespace, tool: rawName } = splitNamespacedName(name)

        // Route to the enabled source whose toolNamespace matches the prefix.
        const sourceRef = enabledSources.find((s) => s.toolNamespace === namespace)
        if (sourceRef === undefined) {
          return err({ kind: "tool-not-found", name } satisfies UpstreamError)
        }

        // FILTER BEFORE CONNECT (leak-free order): check toolFilter on the SourceRef BEFORE
        // calling resolveProvider. resolveProvider eagerly connects (spawns child / opens session),
        // so a denied tool must be rejected here — before any connection is made.
        // AUDIT vs AGENT-FACING split (increment 31 §0 decision 6): internally this is a
        // distinct "tool-denied" kind (so audit can tell deny from unknown), but
        // safeUpstreamMessage (mcp-server) collapses it to the SAME opaque text as
        // "tool-not-found" — the agent must never learn a filtered tool exists.
        if (!isToolAllowed(rawName, sourceRef.toolFilter)) {
          return err({ kind: "tool-denied", name } satisfies UpstreamError)
        }

        // LIST/CALL ≤64 AGREEMENT: if the namespaced name would be skipped at list time
        // (too long or MCP-illegal characters), reject it here too — don't connect.
        const nameCheck = namespaceToolName(namespace, rawName)
        if (nameCheck.isErr()) {
          return err({ kind: "tool-not-found", name } satisfies UpstreamError)
        }

        // Only connect for allowed tools with valid namespaced names.
        const resolveResult = await resolveProvider(sourceRef)
        if (resolveResult.isErr()) return err(resolveResult.error)

        const { provider } = resolveResult.value

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
