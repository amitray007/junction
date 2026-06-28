// SPDX-License-Identifier: AGPL-3.0-only
// Server function wrappers — the ONLY entry point that route loaders import.
// Routes MUST NOT import @junction/core or data.server.ts directly.
//
// Host guard: every handler rejects requests whose Host is not 127.0.0.1 or
// localhost, closing DNS-rebinding / CSRF against the loopback server.

import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { readCredentials, readDashboard, readPlatforms, readProfiles } from "./data.server.js"
import { isLocalHost } from "./host-guard.js"

// Re-export types so route files can annotate useLoaderData() without a
// direct import from data.server.ts (which is server-only by convention).
export type {
  CredentialMeta,
  DashboardData,
  PlatformMeta,
  ProfileMeta,
  SourceMeta,
} from "./data.server.js"

// ---------------------------------------------------------------------------
// DNS-rebinding / CSRF guard — loopback-only
// ---------------------------------------------------------------------------

function assertLocalHost(): void {
  // Defense-in-depth atop the loopback bind + serve.mjs's HTTP-layer Host check.
  // Throw a real 403 Response (not an Error → which TanStack surfaces as a 500).
  if (!isLocalHost(getRequest().headers.get("host"))) {
    throw new Response("Forbidden: access restricted to localhost", { status: 403 })
  }
}

// ---------------------------------------------------------------------------
// Server functions (GET, read-only — no mutations this increment)
// ---------------------------------------------------------------------------

export const getDashboard = createServerFn({ method: "GET" }).handler(async () => {
  assertLocalHost()
  return readDashboard()
})

export const getPlatforms = createServerFn({ method: "GET" }).handler(async () => {
  assertLocalHost()
  return readPlatforms()
})

export const getCredentials = createServerFn({ method: "GET" }).handler(async () => {
  assertLocalHost()
  return readCredentials()
})

export const getProfiles = createServerFn({ method: "GET" }).handler(async () => {
  assertLocalHost()
  return readProfiles()
})

// Sidebar collapse state, read from the request cookie. Lives here (a server-fn
// module) because reading the cookie needs `getRequest()` from
// `@tanstack/react-start/server`, whose import is denied in the client graph —
// route files like __root.tsx may not import it directly. The root `beforeLoad`
// calls this so the initial SSR render emits the correct data-sidebar attribute
// (no width flash). Returns "expanded"/"collapsed" only — never throws.
export const getSidebarState = createServerFn({ method: "GET" }).handler(
  async (): Promise<"expanded" | "collapsed"> => {
    assertLocalHost()
    const cookieHeader = getRequest().headers.get("cookie") ?? ""
    const match = cookieHeader.match(/(?:^|;\s*)junction-sidebar=([^;]*)/)
    return match?.[1] === "collapsed" ? "collapsed" : "expanded"
  },
)
