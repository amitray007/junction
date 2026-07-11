// SPDX-License-Identifier: AGPL-3.0-only
// OAuth connect server function wrappers (increment 29, slice C) — POST
// endpoints for the web "Connect" flow, plus the GET endpoint the
// /oauth/callback loader calls.
// Routes MUST NOT import @junction/core, @junction/source-runtime, or
// oauth-connect.server.ts / pending-auth.server.ts directly.
//
// Every POST handler: (1) assertLocalHost() — loopback Host check (DNS-
// rebinding) PLUS an explicit Origin allowlist (the actual CSRF control —
// see fn-guards.server.ts's assertLocalHost doc comment), and (2) validates
// input before touching core/source-runtime.
//
// The client_secret is an INPUT only — it is NEVER echoed back in any return
// value (startConnect/startReconnect return {authorizeUrl} only).

import { redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { assertLocalHost, requireSecretString, requireString } from "./fn-guards.server.js"
import { completeOAuthCallback, startConnect, startReconnect } from "./oauth-connect.server.js"

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Response(`Bad Request: ${name} must be an array of strings`, { status: 400 })
  }
  return value.map((v) => v.trim()).filter((v) => v.length > 0)
}

const SURFACE_SELECTOR_AUTH_MODES = ["oauth2", "token", "byo"] as const

/**
 * OPTIONAL (post-38 fix — trust boundary) — validate the MINIMAL surface
 * selector {appId, surfaceKind, authMode}. `undefined` is valid (the raw
 * `/credentials` flow never sends this field). This is deliberately NOT a
 * pass-through of any client-assembled connection data (baseUrl/specUrl/
 * endpoint/descriptor) — `startConnect` re-derives platformInput/platformId/
 * displayName from the catalog server-side, keyed by this selector, via the
 * SAME `planConnect` path `connectSurfaceFn` uses. See oauth-connect.server.ts's
 * `StartConnectInput.surfaceSelector` doc comment for the full rationale.
 */
function requireOptionalSurfaceSelector(
  raw: unknown,
): { appId: string; surfaceKind: string; authMode: "oauth2" | "token" | "byo" } | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object") {
    throw new Response("Bad Request: surfaceSelector must be an object", { status: 400 })
  }
  const d = raw as Record<string, unknown>
  const appId = requireString(d.appId, "surfaceSelector.appId")
  const surfaceKind = requireString(d.surfaceKind, "surfaceSelector.surfaceKind")
  const authMode = d.authMode
  if (
    typeof authMode !== "string" ||
    !(SURFACE_SELECTOR_AUTH_MODES as readonly string[]).includes(authMode)
  ) {
    throw new Response(
      `Bad Request: surfaceSelector.authMode must be one of ${SURFACE_SELECTOR_AUTH_MODES.join(", ")}`,
      { status: 400 },
    )
  }
  return { appId, surfaceKind, authMode: authMode as "oauth2" | "token" | "byo" }
}

// ---------------------------------------------------------------------------
// startConnectFn — begin a browser auth-code+PKCE connect for a NEW credential.
// Returns {authorizeUrl} metadata only — the browser navigates there directly
// (window.location.href = authorizeUrl); state/codeVerifier/clientSecret stay
// server-side in the pending-auth Map.
// ---------------------------------------------------------------------------

export const startConnectFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    const surfaceSelector = requireOptionalSurfaceSelector(d.surfaceSelector)
    // EXACTLY ONE of platformId / surfaceSelector — the raw /credentials flow
    // sends platformId (an existing platform picked from a dropdown, no
    // catalog surface to re-derive from); the guided catalog-connect flow
    // sends surfaceSelector (startConnect re-derives platformId from the
    // catalog). Reject either both or neither at the boundary rather than
    // let startConnect silently pick one.
    const rawPlatformId = d.platformId
    const platformId =
      typeof rawPlatformId === "string" && rawPlatformId.trim() !== ""
        ? rawPlatformId.trim()
        : undefined
    if ((platformId === undefined) === (surfaceSelector === undefined)) {
      throw new Response("Bad Request: supply exactly one of platformId or surfaceSelector", {
        status: 400,
      })
    }
    return {
      providerId: requireString(d.providerId, "providerId"),
      clientId: requireString(d.clientId, "clientId"),
      // requireSecretString (32.13 Slice E4) — NOT requireString: an OAuth
      // app's client_secret must not be silently trimmed (same rationale as
      // mutations.functions.ts's credential secret).
      clientSecret: requireSecretString(d.clientSecret, "clientSecret"),
      scopes: requireStringArray(d.scopes, "scopes"),
      account: requireString(d.account, "account"),
      ...(platformId !== undefined ? { platformId } : {}),
      ...(surfaceSelector !== undefined ? { surfaceSelector } : {}),
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return startConnect(data)
  })

// ---------------------------------------------------------------------------
// startReconnectFn — re-run connect for an EXISTING needsReauth credential
// (mode:update). Client creds are OPTIONAL: omitted → reuse the stored
// client_id/secret; supplied → swap to a different OAuth app (see
// oauth-connect.server.ts).
// ---------------------------------------------------------------------------

export const startReconnectFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    // clientId/clientSecret optional — present ONLY when swapping OAuth apps.
    // They are a pair: supply BOTH to swap, or NEITHER to reuse the stored ones.
    // Reject a partial pair at the boundary (validate-at-trust-boundaries) so a
    // half-supplied swap can never silently fall back to the stored creds.
    const clientId = typeof d.clientId === "string" && d.clientId !== "" ? d.clientId : undefined
    const clientSecret =
      typeof d.clientSecret === "string" && d.clientSecret !== "" ? d.clientSecret : undefined
    if ((clientId === undefined) !== (clientSecret === undefined)) {
      throw new Response(
        "Bad Request: supply both clientId and clientSecret to swap credentials, or neither to reuse",
        { status: 400 },
      )
    }
    return {
      credentialId: requireString(d.credentialId, "credentialId"),
      ...(clientId !== undefined ? { clientId } : {}),
      ...(clientSecret !== undefined ? { clientSecret } : {}),
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return startReconnect(data)
  })

// ---------------------------------------------------------------------------
// handleOAuthCallbackFn — the /oauth/callback file-route's loader calls this
// (GET). It is the ONLY place the callback's core/source-runtime work happens
// — the route file itself never imports core or source-runtime (the
// server-only-core boundary: createServerFn strips the handler body from the
// client bundle; getRequest()-backed context only exists inside it).
//
// Consumes `state` single-use via completeOAuthCallback (state IS the CSRF
// guard here — this whole flow is a top-level browser nav, not a
// CSRF-token-guarded server-fn call). Throws redirect() so the browser lands
// on /credentials with a `connect` outcome flag — the loader never returns a
// token/secret; there is nothing sensitive in the redirect target either.
// ---------------------------------------------------------------------------

export const handleOAuthCallbackFn = createServerFn({ method: "GET" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      code: typeof d.code === "string" ? d.code : undefined,
      state: typeof d.state === "string" ? d.state : undefined,
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()

    if (data.code === undefined || data.state === undefined) {
      throw redirect({ to: "/credentials", search: { connect: "error-state" } })
    }

    const result = await completeOAuthCallback(data.code, data.state)
    if (result.outcome === "ok") {
      throw redirect({ to: "/credentials", search: { connect: "ok" } })
    }
    if (result.outcome === "error-state") {
      throw redirect({ to: "/credentials", search: { connect: "error-state" } })
    }
    throw redirect({ to: "/credentials", search: { connect: "error" } })
  })
