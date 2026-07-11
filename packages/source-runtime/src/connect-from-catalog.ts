// SPDX-License-Identifier: AGPL-3.0-only
// connect-from-catalog.ts — the verify-gated executor for catalog-driven
// one-click connect (increment 30.11, method file §3/§4 Slice A). Takes the
// PURE ConnectPlan core's build-recipe.ts produced and runs it through the
// SAME validated add/verify/persist path the manual /credentials +
// /platforms flows use — this module only adds:
//   (a) a platform-id COLLISION GUARD before any write (§3c), and
//   (b) a VERIFY-BEFORE-COMMIT gate so a wrong catalog guess never persists
//       a false-green connection (§3a).
//
// verifyThenAdd  — the verifiable path: verify BEFORE any DB write.
// confirmThenAdd — the not-verifiable path (http/cli, verify:none): the
//   user's explicit confirm IS the gate; write immediately (still guarded by
//   the SAME collision check). Kept as a SEPARATE, explicitly-named function
//   (not an implicit flag on verifyThenAdd) per the method file's explicit
//   instruction — the web caller must deliberately choose which one to call.
//
// SECRET DISCIPLINE: `secret` is plaintext, consumed only by verifyCredential
// (in-memory check) and addCredential (store.set) — never logged, never
// returned, never part of any error cause.
//
// BOUNDARY: source-runtime may import core + other libs (including
// @junction/platform-orchestration) but NOT apps (cli/web) and NOT
// @junction/mcp-server (source-runtime-not-mcp-server, depcruise).

import type {
  AddCredentialInput,
  CredentialError,
  CredentialStore,
  DbError,
  DescriptorPlatformInput,
  Platform,
  PlatformInput,
  Repositories,
  ResultAsync,
} from "@junction/core"
import { addCredential, errAsync, okAsync } from "@junction/core"
import {
  addCliPlatform,
  addGraphQlPlatform,
  addHttpPlatform,
  addMcpPlatform,
  addOpenApiPlatform,
  type PlatformOrchestrationError,
} from "@junction/platform-orchestration"
import type { VerifyOutcome } from "./verify-credential.js"
import { verifyCredential } from "./verify-credential.js"

// ---------------------------------------------------------------------------
// Errors + result shape
// ---------------------------------------------------------------------------

export type ConnectError =
  | { kind: "platform-kind-conflict"; existingKind: string; requestedKind: string }
  | { kind: "assemble-failed"; cause: PlatformOrchestrationError }
  | { kind: "persist-failed"; cause: DbError }
  | { kind: "credential-failed"; cause: CredentialError | DbError }
  /**
   * addCredential's `duplicate-account` guard fired (increment 30.12) — a
   * credential with this `account` label already exists on this platform.
   * Mapped OUT of the generic `credential-failed` wrapper (not nested inside
   * it) so the web layer can distinguish it and surface a per-outcome message
   * on the account field, instead of the generic "Failed to connect".
   */
  | { kind: "duplicate-account"; account: string }

export type ConnectResult =
  | { verified: true; checkedAt: number }
  | { verified: false; outcome: Extract<VerifyOutcome, { status: "auth-failed" | "unreachable" }> }
  | { unverified: true }

export interface VerifyThenAddArgs {
  platformInput: PlatformInput
  displayName: string
  platformId: string
  credentialKind: AddCredentialInput["kind"]
  account: string
  secret: string
  paths: Parameters<typeof verifyCredential>[2]
  repos: Pick<Repositories, "platforms" | "credentials">
  store: CredentialStore
}

export type ConfirmThenAddArgs = Omit<VerifyThenAddArgs, "paths">

// ---------------------------------------------------------------------------
// Shared: collision guard + platform assembly
// ---------------------------------------------------------------------------

/**
 * §3c collision guard: look up the resolved platformId before any write.
 *   - absent            -> proceed (assemble + write).
 *   - exists, SAME kind  -> defensive multi-account case (30.11 defers the UI
 *     path here; the Connect button only shows on an unconnected surface, so
 *     this is reached only if something else already wrote the platform
 *     between preview and confirm). Returns the EXISTING platform — the
 *     caller must NOT re-upsert its connection, only add the credential.
 *   - exists, DIFFERENT kind -> refuse, zero writes.
 *
 * Exported (increment 38 D2) so the web layer can run the SAME collision
 * check at `startConnect`, BEFORE redirecting to the OAuth provider — a
 * platform-kind conflict must fail early, never stranding a completed OAuth
 * grant with nowhere to bind. The callback path re-checks (state may change
 * during the round-trip); this function is the ONE collision-detection
 * implementation both call sites share.
 */
export function checkCollision(
  repos: Pick<Repositories, "platforms">,
  platformId: string,
  requestedKind: string,
): ResultAsync<{ existing: Platform | undefined }, ConnectError> {
  // Resolve the "does a row exist?" question FIRST (mapping the DbError
  // channel down to a plain optional Platform, absent-not-found treated as
  // the "no collision" success case) — THEN branch on same/different kind.
  // Composing andThen+orElse directly on repos.platforms.get would mix the
  // conflict error INTO the same error channel orElse observes, so it's
  // resolved as two separate steps instead.
  const found: ResultAsync<Platform | undefined, ConnectError> = repos.platforms
    .get(platformId)
    .map((platform): Platform | undefined => platform)
    .orElse((dbErr): ResultAsync<Platform | undefined, ConnectError> => {
      if (dbErr.kind === "not-found") return okAsync(undefined)
      return errAsync({ kind: "persist-failed", cause: dbErr })
    })

  return found.andThen((existing) => {
    if (existing === undefined) return okAsync({ existing: undefined })
    if (existing.kind !== requestedKind) {
      return errAsync<{ existing: Platform | undefined }, ConnectError>({
        kind: "platform-kind-conflict",
        existingKind: existing.kind,
        requestedKind,
      })
    }
    return okAsync({ existing })
  })
}

/**
 * Assemble a Platform via the matching orchestration add* call, unwrapping
 * `.platform`. PURE + credential-independent (no store/DB write) — exported
 * (increment 38 D1) so the web layer's `completeOAuthCallback` can assemble
 * the catalog surface's Platform in memory and pass it into
 * `persistOAuthTokens`'s optional `platformBuild` arg, which does the actual
 * `platforms.upsert` (FK-ordered, before `credentials.create`).
 */
export function assemblePlatform(
  platformId: string,
  displayName: string,
  input: PlatformInput,
): ResultAsync<Platform, ConnectError> {
  const toAssembleFailed = (cause: PlatformOrchestrationError): ConnectError => ({
    kind: "assemble-failed",
    cause,
  })

  switch (input.kind) {
    case "mcp":
      return addMcpPlatform({
        id: platformId,
        displayName,
        transport: input.transport,
        url: input.url,
        authHeader: input.authHeader,
        command: input.command,
        args: input.args,
        tokenEnvVar: input.tokenEnvVar,
        env: input.env,
      }).mapErr(toAssembleFailed)
    case "openapi":
      return addOpenApiPlatform({
        id: platformId,
        displayName,
        specUrl: input.specUrl,
        baseUrl: input.baseUrl,
        auth: input.auth,
        maxTools: input.maxTools,
        select: input.select,
        verifyOperationId: input.verifyOperationId,
      })
        .map(({ platform }) => platform)
        .mapErr(toAssembleFailed)
    case "graphql":
      return addGraphQlPlatform({
        id: platformId,
        displayName,
        endpoint: input.endpoint,
        auth: input.auth,
        defaultHeaders: input.defaultHeaders,
      })
        .map(({ platform }) => platform)
        .mapErr(toAssembleFailed)
    case "http":
      return assembleDescriptorPlatform(platformId, displayName, input)
    case "cli":
      return assembleDescriptorPlatform(platformId, displayName, input)
  }
}

function assembleDescriptorPlatform(
  platformId: string,
  displayName: string,
  input: DescriptorPlatformInput,
): ResultAsync<Platform, ConnectError> {
  const toAssembleFailed = (cause: PlatformOrchestrationError): ConnectError => ({
    kind: "assemble-failed",
    cause,
  })
  if (input.kind === "http") {
    return addHttpPlatform({ id: platformId, displayName, descriptor: input.descriptor })
      .map(({ platform }) => platform)
      .mapErr(toAssembleFailed)
  }
  return addCliPlatform({ id: platformId, displayName, descriptor: input.descriptor })
    .map(({ platform }) => platform)
    .mapErr(toAssembleFailed)
}

/** Add the credential to an already-persisted (or about-to-be-persisted) Platform. */
function writeCredential(
  args: Pick<
    VerifyThenAddArgs,
    "platformId" | "account" | "credentialKind" | "secret" | "repos" | "store"
  >,
  platform: Platform,
): ResultAsync<void, ConnectError> {
  return addCredential(
    {
      platformId: args.platformId,
      account: args.account,
      kind: args.credentialKind,
      secret: args.secret,
    },
    platform,
    args.store,
    args.repos.credentials,
  )
    .map(() => undefined)
    .mapErr((cause): ConnectError => {
      if (cause.kind === "duplicate-account") {
        return { kind: "duplicate-account", account: cause.account }
      }
      return { kind: "credential-failed", cause }
    })
}

// ---------------------------------------------------------------------------
// verifyThenAdd — the verify-gated path (§3a)
// ---------------------------------------------------------------------------

/**
 * Execute a "credential" ConnectPlan for a VERIFIABLE surface: assemble the
 * Platform in memory, verify the secret against it BEFORE any DB write, and
 * only on `{status:"ok"}` perform `platforms.upsert` + `addCredential`. On
 * `auth-failed`/`unreachable`, return the outcome with ZERO DB writes (no
 * platform row, no credential row) — this is the method file's hard rule
 * (§0 fact 3 / §3a): a wrong catalog guess must not silently persist.
 *
 * The openapi spec-cache file (written during assembly, read during verify)
 * MAY exist on disk after a failed verify — that is an accepted, idempotent
 * artifact keyed by platformId, NOT a "connection"; the atomicity guarantee
 * here is DB-row-level, not filesystem-level (method file §3a caveat).
 */
/**
 * Shared collision-dispatch skeleton for both connect paths (verifyThenAdd /
 * confirmThenAdd). Runs `checkCollision`, then routes to `onExisting` for a
 * same-kind collision (reuse the EXISTING platform, don't touch its connection)
 * or `onFresh` for a newly-assembled platform. The two callers differ ONLY in
 * those two callbacks — this factors out the identical check-then-branch shell.
 */
function withCollisionDispatch(
  // ConfirmThenAddArgs = Omit<VerifyThenAddArgs, "paths">, so a VerifyThenAddArgs
  // is assignable here too — both call sites share the fields this helper reads
  // (platformInput/displayName/platformId/repos).
  args: ConfirmThenAddArgs,
  onExisting: (existing: Platform) => ResultAsync<ConnectResult, ConnectError>,
  onFresh: (platform: Platform) => ResultAsync<ConnectResult, ConnectError>,
): ResultAsync<ConnectResult, ConnectError> {
  const { platformInput, displayName, platformId, repos } = args
  return checkCollision(repos, platformId, platformInput.kind).andThen(({ existing }) =>
    existing !== undefined
      ? onExisting(existing)
      : assemblePlatform(platformId, displayName, platformInput).andThen(onFresh),
  )
}

export function verifyThenAdd(args: VerifyThenAddArgs): ResultAsync<ConnectResult, ConnectError> {
  return withCollisionDispatch(
    args,
    // Same-kind collision: defensive branch (§3c) — add the credential to the
    // EXISTING platform, do not touch its connection. Still verify first,
    // against the EXISTING platform object (not the fresh guess) so a
    // stale/edited platform is what's actually being proven.
    (existing) => verifyThenWrite(args, existing, /* upsertPlatform */ false),
    (platform) => verifyThenWrite(args, platform, /* upsertPlatform */ true),
  )
}

function verifyThenWrite(
  args: VerifyThenAddArgs,
  platform: Platform,
  upsertPlatform: boolean,
): ResultAsync<ConnectResult, ConnectError> {
  return verifyCredential(platform, args.secret, args.paths).andThen(
    (outcome): ResultAsync<ConnectResult, ConnectError> => {
      if (outcome.status === "auth-failed" || outcome.status === "unreachable") {
        // ZERO DB writes — neither platforms.upsert nor addCredential runs.
        return okAsync({ verified: false, outcome })
      }

      // status is "ok" or "not-verifiable" here; verifyThenAdd is only ever
      // called for a VERIFIABLE plan (the caller — connect.server.ts — routes
      // not-verifiable plans to confirmThenAdd instead), so "not-verifiable" is
      // not expected in practice, but if reached it is treated the SAME as a
      // failure to write anonymously: only "ok" persists.
      if (outcome.status !== "ok") {
        return okAsync({
          verified: false,
          outcome: { status: "unreachable", detail: outcome.reason },
        })
      }

      const persist: ResultAsync<Platform, ConnectError> = upsertPlatform
        ? args.repos.platforms
            .upsert(platform)
            .mapErr((cause): ConnectError => ({ kind: "persist-failed", cause }))
        : okAsync(platform)

      return persist
        .andThen(() => writeCredential(args, platform))
        .map((): ConnectResult => ({ verified: true, checkedAt: Date.now() }))
    },
  )
}

// ---------------------------------------------------------------------------
// confirmThenAdd — the not-verifiable, confirm-gated path (§3b)
// ---------------------------------------------------------------------------

/**
 * Execute a "credential" ConnectPlan for a NOT-VERIFIABLE surface (http/cli,
 * `verify:none`). There is nothing to dry-run — the user's explicit confirm
 * IS the gate — so this writes immediately (still behind the SAME collision
 * guard as verifyThenAdd): upsert (or credential-only, on a same-kind
 * collision) + addCredential. Kept as an explicitly separate function (not an
 * implicit skip-verify flag) so a caller can never accidentally skip
 * verification on a surface that actually offers it.
 */
export function confirmThenAdd(args: ConfirmThenAddArgs): ResultAsync<ConnectResult, ConnectError> {
  return withCollisionDispatch(
    args,
    (existing) => writeCredential(args, existing).map((): ConnectResult => ({ unverified: true })),
    (platform) =>
      args.repos.platforms
        .upsert(platform)
        .mapErr((cause): ConnectError => ({ kind: "persist-failed", cause }))
        .andThen(() => writeCredential(args, platform))
        .map((): ConnectResult => ({ unverified: true })),
  )
}
