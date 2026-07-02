// SPDX-License-Identifier: AGPL-3.0-only
// Probe + call server function wrappers — POST endpoints for the in-browser
// debug surface (increment 28). Routes MUST NOT import @junction/core or
// probe.server.ts directly.
//
// Every handler: (1) PURE validator (requireString on profileId/namespace/
// toolName; argsJson is a plain string, default "{}") → (2) assertLocalHost()
// (DNS-rebinding / CSRF guard) → (3) the server helper, referenced INSIDE the
// handler body (never at module scope — the inc-27 client-graph-leak trap:
// createServerFn only strips the handler body from the client bundle).
//
// These are READS — no persisted state changes, so the route never calls
// router.invalidate() after them.

import { createServerFn } from "@tanstack/react-start"
import { assertLocalHost, requireString } from "./fn-guards.server.js"
import { callSourceTool, probeSource } from "./probe.server.js"

// Re-export the metadata result TYPES so route files can annotate without
// importing probe.server.ts (server-only by convention).
export type { CallSourceToolResult, ProbeSourceResult, ProbeToolEntry } from "./probe.server.js"

export const probeSourceFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      profileId: requireString(d.profileId, "profileId"),
      namespace: requireString(d.namespace, "namespace"),
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return probeSource(data)
  })

export const callSourceToolFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      profileId: requireString(d.profileId, "profileId"),
      namespace: requireString(d.namespace, "namespace"),
      toolName: requireString(d.toolName, "toolName"),
      argsJson: typeof d.argsJson === "string" ? d.argsJson : "{}",
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return callSourceTool(data)
  })
