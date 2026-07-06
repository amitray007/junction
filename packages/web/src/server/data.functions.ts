// SPDX-License-Identifier: AGPL-3.0-only
// Server function wrappers — the ONLY entry point that route loaders import.
// Routes MUST NOT import @junction/core or data.server.ts directly.
//
// Host guard: every handler rejects requests whose Host is not 127.0.0.1 or
// localhost, closing DNS-rebinding / CSRF against the loopback server.

import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import {
  readAppDetail,
  readApps,
  readCredentials,
  readDashboard,
  readOAuthProviders,
  readPlatforms,
  readProfiles,
  readSettings,
  readSystemInfo,
} from "./data.server.js"
import { assertLocalHost, requireString } from "./fn-guards.server.js"

// Re-export types so route files can annotate useLoaderData() without a
// direct import from data.server.ts (which is server-only by convention).
export type {
  AppDetail,
  AppGroupMeta,
  AppMeta,
  AppsData,
  ConnectionMeta,
  CredentialMeta,
  DashboardData,
  OAuthProviderMeta,
  PlatformMeta,
  ProfileMeta,
  SettingsData,
  SourceMeta,
  SurfaceConnectable,
  SurfaceConnection,
  SurfaceView,
  SystemInfo,
} from "./data.server.js"

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

// Apps (increment 30) — the derived "connect a service" surface. See
// readApps' header comment in data.server.ts for the {catalog, groups} shape.
export const getApps = createServerFn({ method: "GET" }).handler(async () => {
  assertLocalHost()
  return readApps()
})

// App detail (increment 30.10) — the surface-first /app/:id capability view.
// GET-with-param, same convention as platform-mutations.functions.ts's
// getPlatformDetailFn: a pure validator + assertLocalHost() + the server helper.
export const getAppDetail = createServerFn({ method: "GET" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return { id: requireString(d.id, "id") }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return readAppDetail(data.id)
  })

// The catalog is pure data (no I/O) — readOAuthProviders is synchronous, but
// the server-fn wrapper stays async for consistency with the rest of this file.
export const getOAuthProviders = createServerFn({ method: "GET" }).handler(async () => {
  assertLocalHost()
  return readOAuthProviders()
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

// Settings data: the resolved MCP host + where it came from.
// Dedicated fn (not folded into DashboardData) for cleaner separation — Settings
// and Dashboard read independently; no resolve-logic duplication.
export const getSettings = createServerFn({ method: "GET" }).handler(async () => {
  assertLocalHost()
  return readSettings()
})

// System info (Store / Sandbox / Home) — used by the sidebar panel.
// Lightweight: no DB access, metadata-only. Called from __root.tsx beforeLoad
// in parallel with getSidebarState so the sidebar always has fresh values.
export const getSystemInfo = createServerFn({ method: "GET" }).handler(async () => {
  assertLocalHost()
  return readSystemInfo()
})
