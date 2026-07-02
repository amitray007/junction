// SPDX-License-Identifier: AGPL-3.0-only
// createScopedProxy — the multi-profile aggregation layer on top of per-profile
// ProfileProxy instances (increment 27 §2.4). Consumed by the HTTP /mcp
// endpoint (mcp/server) to serve a junction-key's resolved scope.
//
// ARITY (fixed at mint, §1 decision #4):
//   prefixed:false (scope kind 'profile')            → passthrough, byte-identical
//                                                        tool names to stdio serving
//                                                        of that one profile.
//   prefixed:true  (scope kind 'profiles' | 'global') → <profileName>__<namespace>__<tool>,
//                                                        ALWAYS (not collision-conditional).
//
// ≤64 GUARD RE-APPLIED (not duplicated): each per-profile ProfileProxy already
// enforces the ≤64 / MCP-charset guard on its own <namespace>__<tool> names
// (sources/naming.ts, via createProfileProxy). This layer re-applies the SAME
// check (namespaceToolName) to the FINAL prefixed name — an over-long prefixed
// name is skipped consistently in list AND call, matching the existing
// single-profile convention.
//
// CHARSET CONTRACT (load-bearing — see schema/primitives.ts):
//   profile names never contain `_` (ProfileNameSchema) and namespaces never
//   contain `__` (ToolNamespaceSchema), so splitting a prefixed name on the
//   FIRST `__` unambiguously recovers `<profileName>` from
//   `<profileName>__<namespace>__<tool>`.

import type { UpstreamError } from "../errors/index.js"
import { err, ok, type Result, ResultAsync } from "../result/index.js"
import { namespaceToolName } from "./naming.js"
import type { ProviderTool, ToolResult } from "./provider.js"
import type { ProfileProxy } from "./proxy.js"

export type ScopedProxyEntry = {
  profileName: string
  proxy: ProfileProxy
}

/** Multi-profile proxy aggregating one or more ProfileProxy instances under a single key's scope. */
export interface ScopedProxy {
  listTools(): ResultAsync<ProviderTool[], UpstreamError>
  callTool(name: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError>
}

/**
 * Build a ScopedProxy over one or more profiles.
 *
 * @param entries  - the key's resolved scope: profile name + its ProfileProxy.
 * @param prefixed - false (scope kind 'profile'): passthrough to the single
 *                   profile's proxy, unchanged tool names.
 *                   true (scope kind 'profiles'/'global'): prepend
 *                   `<profileName>__` to every tool name; split on the FIRST
 *                   `__` to route callTool back to the right profile.
 */
export function createScopedProxy(entries: ScopedProxyEntry[], prefixed: boolean): ScopedProxy {
  // Passthrough: single-profile, unprefixed — byte-identical to stdio serving.
  if (!prefixed) {
    const only = entries[0]
    if (only === undefined) {
      // No entries + unprefixed shouldn't happen in practice (scope kind
      // 'profile' always has exactly 1 row), but stay fail-safe: empty proxy.
      return {
        listTools: () => new ResultAsync(Promise.resolve(ok([]))),
        callTool: (name) =>
          new ResultAsync(
            Promise.resolve(err({ kind: "tool-not-found", name } satisfies UpstreamError)),
          ),
      }
    }
    return only.proxy
  }

  return {
    listTools(): ResultAsync<ProviderTool[], UpstreamError> {
      const work = async (): Promise<Result<ProviderTool[], UpstreamError>> => {
        const perProfile = await Promise.all(
          entries.map(async ({ profileName, proxy }) => {
            const result = await proxy.listTools()
            if (result.isErr()) return [] as ProviderTool[]

            const prefixedTools: ProviderTool[] = []
            for (const tool of result.value) {
              // Re-apply the SAME ≤64/charset guard to the FINAL prefixed name.
              const nameResult = namespaceToolName(profileName, tool.name)
              if (nameResult.isErr()) continue // skip — over-long or illegal, matches call-side skip
              prefixedTools.push({ ...tool, name: nameResult.value })
            }
            return prefixedTools
          }),
        )
        return ok(perProfile.flat())
      }
      return new ResultAsync(work())
    },

    callTool(name: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError> {
      const execute = async (): Promise<Result<ToolResult, UpstreamError>> => {
        // Split on the FIRST `__`: profile names never contain `_`
        // (ProfileNameSchema), so this is unambiguous.
        const idx = name.indexOf("__")
        if (idx === -1) return err({ kind: "tool-not-found", name } satisfies UpstreamError)
        const profileName = name.slice(0, idx)
        const remainder = name.slice(idx + 2)

        const entry = entries.find((e) => e.profileName === profileName)
        if (entry === undefined)
          return err({ kind: "tool-not-found", name } satisfies UpstreamError)

        // LIST/CALL ≤64 AGREEMENT: if the prefixed name would be skipped at
        // list time, reject it here too — mirrors createProfileProxy's own
        // agreement check for the inner namespace__tool guard.
        const nameCheck = namespaceToolName(profileName, remainder)
        if (nameCheck.isErr()) return err({ kind: "tool-not-found", name } satisfies UpstreamError)

        return entry.proxy.callTool(remainder, args)
      }
      return new ResultAsync(execute())
    },
  }
}
