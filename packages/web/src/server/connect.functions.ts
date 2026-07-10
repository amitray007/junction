// SPDX-License-Identifier: AGPL-3.0-only
// Server function wrappers for catalog-driven one-click connect (increment
// 30.11, method file §4 Slice B). Routes MUST NOT import @junction/core,
// @junction/source-runtime, or connect.server.ts directly.
//
// Every handler: (1) assertLocalHost() — loopback Host check (DNS-rebinding)
// PLUS an explicit Origin allowlist (the actual CSRF control — see
// fn-guards.server.ts's assertLocalHost doc comment for why the Host check
// alone does not stop CSRF), and (2) validates input before touching core.
// The secret is an INPUT only — never echoed back in any return value
// (mirrors mutations.functions.ts).

import { createServerFn } from "@tanstack/react-start"
import { connectSurface } from "./connect.server.js"
import { assertLocalHost, requireString } from "./fn-guards.server.js"

// Re-export types so route files can annotate without a direct import from
// connect.server.ts (server-only by convention).
export type { ConnectFnResult } from "./connect.server.js"

const AUTH_MODES = ["oauth2", "token", "byo", "none"] as const
type AuthMode = (typeof AUTH_MODES)[number]

function requireAuthMode(value: unknown): AuthMode {
  if (typeof value === "string" && (AUTH_MODES as readonly string[]).includes(value)) {
    return value as AuthMode
  }
  throw new Response(`Bad Request: authMode must be one of ${AUTH_MODES.join(", ")}`, {
    status: 400,
  })
}

/** PURE validator for the {appId, surfaceKind, authMode} triple connectSurfaceFn requires. */
function requireConnectTarget(d: Record<string, unknown>): {
  appId: string
  surfaceKind: string
  authMode: AuthMode
} {
  return {
    appId: requireString(d.appId, "appId"),
    surfaceKind: requireString(d.surfaceKind, "surfaceKind"),
    authMode: requireAuthMode(d.authMode),
  }
}

// ---------------------------------------------------------------------------
// connectSurfaceFn — POST, the write path
// ---------------------------------------------------------------------------

export const connectSurfaceFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      ...requireConnectTarget(d),
      account: requireString(d.account, "account"),
      // secret is intentionally NOT validated with requireString here: an
      // oauth2-mode request never carries one, and connect.server.ts (I5)
      // rejects an empty/missing secret for the credential path itself —
      // the layered guard the method file calls for (defense in depth).
      secret: typeof d.secret === "string" ? d.secret : undefined,
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return connectSurface(data)
  })
