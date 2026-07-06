// SPDX-License-Identifier: AGPL-3.0-only
// connect.server.ts — server-only helpers for catalog-driven one-click connect
// (increment 30.11, method file §4 Slice B). The ONLY module in @junction/web
// that calls planConnect / verifyThenAdd / confirmThenAdd. Called exclusively
// from connect.functions.ts createServerFn handlers.
//
// SECURITY: the plaintext secret is a plain string, consumed ONLY inside
// connectSurface() (passed to verifyThenAdd/confirmThenAdd) — never returned,
// logged, or included in any error. getConnectPlan returns ONLY
// ConnectPlanPreview (metadata-only — see build-recipe.ts) — never the raw
// recipe/connection, never a secret. Mirrors mutations.server.ts's discipline.

import type {
  AppCatalogEntry,
  AppSurface,
  ConnectChoice,
  ConnectPlanPreview,
  RecipeError,
} from "@junction/core"
import {
  createCredentialStore,
  createRepositories,
  getCatalogEntry,
  getPaths,
  planConnect,
  toConnectPlanPreview,
} from "@junction/core"
import type { ConnectError } from "@junction/source-runtime"
import { confirmThenAdd, verifyThenAdd } from "@junction/source-runtime"
import { getDb } from "./shared.server.js"

// Re-exported alongside the function signatures that use it.
export type { ConnectPlanPreview } from "@junction/core"

// ---------------------------------------------------------------------------
// Shared: resolve {entry, surface} for an appId/surfaceKind pair, or a typed miss.
// ---------------------------------------------------------------------------

export type CatalogLookupError =
  | { kind: "app-not-found" }
  | { kind: "surface-not-found"; surfaceKind: string }

function lookupSurface(
  appId: string,
  surfaceKind: string,
): { entry: AppCatalogEntry; surface: AppSurface } | CatalogLookupError {
  const entry = getCatalogEntry(appId)
  if (entry === undefined || entry.surfaces === undefined) {
    return { kind: "app-not-found" }
  }
  const surface = entry.surfaces.find((s) => s.kind === surfaceKind)
  if (surface === undefined) {
    return { kind: "surface-not-found", surfaceKind }
  }
  return { entry, surface }
}

function isLookupError(
  value: { entry: AppCatalogEntry; surface: AppSurface } | CatalogLookupError,
): value is CatalogLookupError {
  return "kind" in value
}

// ---------------------------------------------------------------------------
// getConnectPlan — GET, metadata-only preview
// ---------------------------------------------------------------------------

export type GetConnectPlanResult =
  | { ok: true; preview: ConnectPlanPreview }
  | { ok: false; error: string }

export async function getConnectPlan(input: {
  appId: string
  surfaceKind: string
  authMode: ConnectChoice["authMode"]
}): Promise<GetConnectPlanResult> {
  const looked = lookupSurface(input.appId, input.surfaceKind)
  if (isLookupError(looked)) {
    return { ok: false, error: catalogLookupErrorMessage(looked) }
  }
  const { entry, surface } = looked

  const plan = planConnect(entry, surface, { authMode: input.authMode })
  if (!("path" in plan)) {
    return { ok: false, error: recipeErrorMessage(plan) }
  }

  return { ok: true, preview: toConnectPlanPreview(entry, surface, plan) }
}

function catalogLookupErrorMessage(error: CatalogLookupError): string {
  if (error.kind === "app-not-found") return "App not found in catalog"
  return `Surface "${error.surfaceKind}" not found for this app`
}

function recipeErrorMessage(error: RecipeError): string {
  switch (error.kind) {
    case "auth-mode-unavailable":
      return `This surface does not offer "${error.requested}" — available: ${error.offered.join(", ")}`
    case "descriptor-no-starter-tools":
      return `This surface has no starter tools configured (${error.surfaceKind})`
    case "unsupported-via":
      return `This surface's catalog recipe is not connectable (${error.via})`
    default: {
      const _exhaustive: never = error
      return _exhaustive
    }
  }
}

// ---------------------------------------------------------------------------
// connectSurface — POST, the actual write path
// ---------------------------------------------------------------------------

export type ConnectFnResult =
  | { handoff: string; providerId: string }
  | { ok: true; checkedAt: number }
  | { ok: true; unverified: true }
  | { verifyFailed: "auth-failed" | "unreachable"; detail?: string }
  | { conflict: { existingKind: string } }
  | { error: string }

export async function connectSurface(input: {
  appId: string
  surfaceKind: string
  authMode: ConnectChoice["authMode"]
  account: string
  /** Required for token/byo modes; absent/ignored for oauth2 (deep-link, no write). */
  secret?: string
}): Promise<ConnectFnResult> {
  const looked = lookupSurface(input.appId, input.surfaceKind)
  if (isLookupError(looked)) {
    return { error: catalogLookupErrorMessage(looked) }
  }
  const { entry, surface } = looked

  // Re-run planConnect server-side — NEVER trust a client-passed plan.
  const plan = planConnect(entry, surface, { authMode: input.authMode })
  if (!("path" in plan)) {
    return { error: recipeErrorMessage(plan) }
  }

  if (plan.path === "oauth-handoff") {
    return { handoff: "/credentials", providerId: plan.providerId }
  }

  // credential path — defense in depth (I5): reject an empty secret BEFORE
  // any verify/write runs, mirroring the inc-28.9 anonymous-verify guard.
  const secret = input.secret ?? ""
  if (secret.trim() === "") {
    return { error: "A secret is required to connect this surface" }
  }

  const db = await getDb()
  if (db === null) return { error: "Database unavailable" }

  const storeResult = await createCredentialStore(getPaths())
  if (storeResult.isErr()) return { error: "Credential store unavailable" }

  const repos = createRepositories(db)
  const displayName = surface.displayName

  if (plan.verifiable) {
    const result = await verifyThenAdd({
      platformInput: plan.platformInput,
      displayName,
      platformId: plan.platformId,
      credentialKind: plan.credentialKind,
      account: input.account,
      secret,
      paths: getPaths(),
      repos,
      store: storeResult.value,
    })
    return mapVerifyThenAddResult(result)
  }

  const result = await confirmThenAdd({
    platformInput: plan.platformInput,
    displayName,
    platformId: plan.platformId,
    credentialKind: plan.credentialKind,
    account: input.account,
    secret,
    repos,
    store: storeResult.value,
  })
  return mapConfirmThenAddResult(result)
}

function mapVerifyThenAddResult(
  result: Awaited<ReturnType<typeof verifyThenAdd>>,
): ConnectFnResult {
  if (result.isErr()) return mapConnectError(result.error)
  const value = result.value
  if ("verified" in value && value.verified) {
    return { ok: true, checkedAt: value.checkedAt }
  }
  if ("unverified" in value) {
    return { ok: true, unverified: true }
  }
  // { verified: false, outcome }
  return {
    verifyFailed: value.outcome.status,
    ...("detail" in value.outcome && value.outcome.detail !== undefined
      ? { detail: value.outcome.detail }
      : {}),
  }
}

function mapConfirmThenAddResult(
  result: Awaited<ReturnType<typeof confirmThenAdd>>,
): ConnectFnResult {
  if (result.isErr()) return mapConnectError(result.error)
  return { ok: true, unverified: true }
}

function mapConnectError(error: ConnectError): ConnectFnResult {
  if (error.kind === "platform-kind-conflict") {
    return { conflict: { existingKind: error.existingKind } }
  }
  return { error: "Failed to connect this surface" }
}
