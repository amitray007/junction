// SPDX-License-Identifier: AGPL-3.0-only
// parseWireName — arity-aware split of the FULL wire tool name (audit only).
//
// Relocated cli→core at increment 33 Slice A: it's a pure arity-split helper
// with no cli/mcp-server dependency, and a later code-mode package needs the
// SAME audit-target derivation for tool calls it makes on the guest's behalf
// via a wire-style name — so its only boundary-valid home is core (mirrors
// emit.ts's placement; see docs/methods/33a-audit-foundation.md).

import { splitNamespacedName } from "../sources/naming.js"
import type { AuditTarget } from "./schema.js"

/**
 * Split the wire-format tool name into `{ profile, namespace, tool }` for the
 * AUDIT target — NOT used for routing (the proxy itself already routes the
 * call; this just re-derives the same split for the audit line).
 *
 * LOAD-BEARING (docs/methods/31-audit.md §2 B3-name-parse): the shape of
 * `name` depends on arity:
 *   - unprefixed (`prefixed:false` — single-profile stdio / scope:"profile"):
 *     `name` is `<namespace>__<tool>` → `splitNamespacedName` alone is
 *     correct; `profile` comes from the principal's single profile.
 *   - prefixed (`prefixed:true` — scope:"profiles"|"global"): `name` is
 *     `<profileName>__<namespace>__<tool>`. Calling `splitNamespacedName`
 *     directly would WRONGLY read `namespace = <profileName>`. So: split ONCE
 *     on the FIRST `__` to peel `<profileName>` (charset contract — profile
 *     names carry no `_`, namespaces carry no `__` — scoped-proxy.ts), THEN
 *     `splitNamespacedName` the remainder for `{namespace, tool}`.
 */
// Exported for the arity-split unit test (audit-only pure helper; the arity
// split was a doc-review blocker — locked by a table test in wire-name.test.ts).
export function parseWireName(name: string, prefixed: boolean, singleProfile: string): AuditTarget {
  if (!prefixed) {
    const { namespace, tool } = splitNamespacedName(name)
    return { profile: singleProfile, namespace, tool }
  }

  const idx = name.indexOf("__")
  if (idx === -1) {
    // No separator at all — shouldn't happen for a validly-routed prefixed
    // name, but stay fail-safe rather than throw from an audit-only path.
    return { profile: "", namespace: "", tool: name }
  }
  const profile = name.slice(0, idx)
  const remainder = name.slice(idx + 2)
  const { namespace, tool } = splitNamespacedName(remainder)
  return { profile, namespace, tool }
}
