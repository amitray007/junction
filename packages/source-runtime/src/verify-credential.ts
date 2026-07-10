// SPDX-License-Identifier: AGPL-3.0-only
// verifyCredential — honest, per-source-kind verify-on-add / test-connection.
//
// THE HONESTY MATRIX (do NOT blur these — see method file 28.9):
//   oauth2 (token)   : when the credential's providerId (opts.oauthProviderId) has a
//                       catalog userinfoUrl, verify the TOKEN against that endpoint —
//                       "is my OAuth connection good?" is about the token, not the
//                       platform's source. Takes precedence over the kind-dispatch
//                       below; falls through when not applicable (no providerId /
//                       no userinfo endpoint / no token).
//   mcp (http+stdio) : buildProvider + listTools — REAL authenticated round-trip.
//   graphql          : buildProvider + graphql_query {__typename} — REAL, side-effect-free.
//   openapi          : ONLY if platform.openapi.verifyOperationId is set — calls that op
//                       with {} — REAL when designated; else not-verifiable (junction never
//                       auto-picks a GET; that would be firing a request the operator didn't
//                       choose). listTools on openapi is spec PARSING — NO network — and must
//                       never be presented as verification.
//   cli              : always not-verifiable (running a command has side effects).
//
// VerifyOutcome is ALWAYS Ok — failures are OUTCOMES (auth-failed / unreachable /
// not-verifiable), never Err. This function never throws across its boundary.
//
// SECRET DISCIPLINE: the outcome carries NO secret, NO request URL, NO response body.
// The OpenAPI path parses only the leading "NNN " status line and discards the body
// immediately — never persisted, never returned to any caller.

import type { JunctionPaths, OAuthProvider, Platform, ToolProvider } from "@junction/core"
import { getProvider, ResultAsync } from "@junction/core"
import { sanitizeOperationId } from "@junction/openapi-client"
import { buildProvider } from "./build-provider.js"

// ---------------------------------------------------------------------------
// VerifyOutcome
// ---------------------------------------------------------------------------

export type VerifyOutcome =
  | { status: "ok" }
  | { status: "auth-failed" }
  | { status: "unreachable"; detail: string }
  | { status: "not-verifiable"; reason: string }

/** Max wait for the OAuth userinfo check — a hanging endpoint must not stall
 * Test Connection. On timeout the fetch aborts → unreachable. */
const USERINFO_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Auth heuristic — mirrors mcp/client connect.ts's isAuthError, applied to
// GraphQL's "200 + errors" shadow path (see graphql branch below).
// ---------------------------------------------------------------------------

function looksLikeAuthError(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("401") ||
    lower.includes("403")
  )
}

/**
 * Parse the leading "NNN " HTTP status code from an openapi-client ToolResult
 * text (format: `"<status> <statusText>\n<body>"` — see openapi-client/http.ts).
 * Returns undefined if the text doesn't start with a 3-digit status code.
 */
function parseLeadingStatus(text: string): number | undefined {
  const match = /^(\d{3})\s/.exec(text)
  if (match?.[1] === undefined) return undefined
  return Number.parseInt(match[1], 10)
}

/** Extract the first text content block from a ToolResult, or "" if absent. */
function firstText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const first = content[0] as { type?: unknown; text?: unknown } | undefined
  if (first === undefined || first.type !== "text" || typeof first.text !== "string") return ""
  return first.text
}

/**
 * OAuth-native token check: GET the provider's userinfo endpoint with the token
 * as a bearer. 2xx → the token is live (ok); 401/403 → auth-failed; anything
 * else / a network error → unreachable.
 *
 * SECRET DISCIPLINE: the token flows ONLY into the Authorization header; the
 * outcome's `detail` carries only an HTTP status or an error constructor name —
 * NEVER the token, NEVER the response body (a userinfo body identifies the user
 * and may echo request data; the body is read only for a provider whose 2xx can
 * still carry an in-body error, then discarded).
 */
async function verifyOAuthToken(provider: OAuthProvider, token: string): Promise<VerifyOutcome> {
  const url = provider.userinfoUrl
  if (url === undefined) return { status: "not-verifiable", reason: "no userinfo endpoint" }

  let response: Response
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        // Spread the catalog's non-auth headers FIRST, then set Accept +
        // Authorization LAST — so the bearer can never be overridden by a
        // catalog entry that (accidentally) carried an Authorization/Accept
        // key. Structural guarantee, not just the catalog.test.ts data guard.
        ...provider.userinfoHeaders,
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      // Bound the wait: a slow/hanging userinfo endpoint must not stall Test
      // Connection (mutateAddCredential / testCredential) indefinitely. On
      // timeout, fetch rejects with an AbortError → caught below → unreachable.
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    })
  } catch (cause) {
    // Network-level failure / timeout — never surface the cause message (could
    // echo the URL/request); the constructor name is a leak-safe label.
    return {
      status: "unreachable",
      detail: cause instanceof Error ? cause.constructor.name : "fetch-failed",
    }
  }

  // Release the socket promptly on the paths that don't read the body — the
  // token check only needs the status, so cancel the unread stream rather than
  // leave it dangling until GC.
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    return { status: "auth-failed" }
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel()
    return { status: "unreachable", detail: `HTTP ${response.status}` }
  }

  // Every current catalog provider's 2xx already means live (a plain bearer
  // GET with no in-body error signaling) — we only needed the status, so
  // release the unread body. A future provider whose 2xx can still carry a
  // dead token (e.g. Slack's `{ok:false}`-at-200, removed with its provider
  // in inc 35) would special-case here, matching its own catalog behavior.
  await response.body?.cancel()

  return { status: "ok" }
}

/**
 * Build a provider for `platform`, run `fn` against it, and ALWAYS close it
 * (finally) — the shared shape behind the openapi/graphql/mcp branches below,
 * which differ only in which provider method they call and how they read the
 * result.
 *
 * A buildProvider failure whose kind is "auth-failed" maps to "auth-failed" —
 * NOT "unreachable". This matters most for MCP: buildProvider EAGERLY connects
 * for MCP (unlike openapi/graphql, which only touch the network on the first
 * callTool), so a wrong token's 401/403 surfaces right here, at connect time.
 * Collapsing every buildProvider error to "unreachable" would report the
 * primary "wrong token" case as unreachable instead of Auth Failed. Every
 * OTHER buildProvider error kind (connect-failed/timed-out/binary-not-found/
 * upstream-unavailable/...) still means the provider never came up, and stays
 * "unreachable".
 */
async function withProvider(
  platform: Platform,
  secret: string | null,
  paths: JunctionPaths,
  fn: (provider: ToolProvider) => Promise<VerifyOutcome>,
): Promise<VerifyOutcome> {
  // withProvider is only ever called from the openapi/graphql/mcp branches
  // below — the "cli" branch of verifyCredentialAsync returns not-verifiable
  // before ever reaching here, so buildProvider's cli branch (the only one
  // that consults `kind`) never sees this tag. "bearer" is a placeholder that
  // is structurally never read.
  const resolvedSecret = secret === null ? null : { kind: "bearer" as const, value: secret }
  const providerResult = await buildProvider(platform, resolvedSecret, paths)
  if (providerResult.isErr()) {
    if (providerResult.error.kind === "auth-failed") return { status: "auth-failed" }
    return { status: "unreachable", detail: formatDetail(providerResult.error) }
  }
  const provider = providerResult.value
  try {
    return await fn(provider)
  } finally {
    // A rejecting close() must never escape as a throw across this function's
    // boundary — verifyCredential's contract is ALWAYS Ok(VerifyOutcome).
    await provider.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// verifyCredential
// ---------------------------------------------------------------------------

/**
 * Verify a credential against its platform's real upstream, honestly, per the
 * kind-specific matrix above. ALWAYS resolves Ok(VerifyOutcome) — verification
 * failures are outcomes, not Err — so callers never need a separate error path.
 *
 * @param platform - the Platform row (kind + connection/openapi/graphql descriptor).
 * @param secret   - resolved plaintext credential, or null for public/no-auth sources.
 * @param paths    - Junction paths (needed by buildProvider for the openapi spec cache).
 */
export function verifyCredential(
  platform: Platform,
  secret: string | null,
  paths: JunctionPaths,
  opts?: VerifyOptions,
): ResultAsync<VerifyOutcome, never> {
  return ResultAsync.fromSafePromise(verifyCredentialAsync(platform, secret, paths, opts))
}

/** Extra context for verification. `oauthProviderId` (from a credential's
 * oauthMeta) enables the OAuth-native token check — verifying the TOKEN against
 * the provider's userinfo endpoint rather than the platform's source. */
export interface VerifyOptions {
  oauthProviderId?: string
}

async function verifyCredentialAsync(
  platform: Platform,
  secret: string | null,
  paths: JunctionPaths,
  opts?: VerifyOptions,
): Promise<VerifyOutcome> {
  // OAuth-native token check FIRST: for an oauth2 credential whose provider has
  // a userinfo endpoint, "is my connection good?" means "is the TOKEN live?" —
  // a different question than "is the platform's source reachable?". Verify the
  // token directly; only fall through to the source-verify below when this
  // isn't applicable (no providerId / no userinfo endpoint / no token).
  const providerId = opts?.oauthProviderId
  if (providerId !== undefined && secret !== null && secret !== "") {
    const provider = getProvider(providerId)
    if (provider?.userinfoUrl !== undefined) {
      return verifyOAuthToken(provider, secret)
    }
  }

  if (platform.kind === "cli") {
    return { status: "not-verifiable", reason: "running a command has side effects" }
  }

  if (platform.kind === "openapi") {
    const verifyOperationId = platform.openapi?.verifyOperationId
    if (verifyOperationId === undefined) {
      return { status: "not-verifiable", reason: "set a verify operation on the platform" }
    }

    return withProvider(platform, secret, paths, async (provider) => {
      // openapi-client's runtime call path matches SANITIZED tool names
      // (sanitizeOperationId: non-[a-zA-Z0-9_-] → "_", truncate 64), not the
      // raw operationId string from the spec. A dotted id like "users.me"
      // validates fine at add time but must be sanitized here or it verifies
      // as tool-not-found → unreachable forever.
      const callResult = await provider.callTool(sanitizeOperationId(verifyOperationId), {})
      if (callResult.isErr()) {
        const e = callResult.error
        if (e.kind === "auth-failed") return { status: "auth-failed" }
        return { status: "unreachable", detail: formatDetail(e) }
      }
      // openapi-client's ToolResult text is "<status> <statusText>\n<body>" —
      // parse ONLY the leading status; the body is discarded immediately.
      const text = firstText(callResult.value.content)
      const httpStatus = parseLeadingStatus(text)
      if (httpStatus === undefined) {
        return { status: "unreachable", detail: "unexpected response shape" }
      }
      if (httpStatus >= 200 && httpStatus < 300) return { status: "ok" }
      if (httpStatus === 401 || httpStatus === 403) return { status: "auth-failed" }
      return { status: "unreachable", detail: `HTTP ${httpStatus}` }
    })
  }

  if (platform.kind === "graphql") {
    return withProvider(platform, secret, paths, async (provider) => {
      const callResult = await provider.callTool("graphql_query", { query: "{ __typename }" })
      if (callResult.isErr()) {
        const e = callResult.error
        if (e.kind === "auth-failed") return { status: "auth-failed" }
        return { status: "unreachable", detail: formatDetail(e) }
      }
      const result = callResult.value
      if (result.isError === true) {
        // Shadow path: HTTP 200 + a GraphQL errors array. Apply the auth
        // heuristic to the (non-secret) errors text — never a fake green,
        // never a fake red: only classify as auth-failed on a clear textual
        // signal, else honestly unreachable.
        const text = firstText(result.content)
        if (looksLikeAuthError(text)) return { status: "auth-failed" }
        return { status: "unreachable", detail: "graphql returned errors" }
      }
      return { status: "ok" }
    })
  }

  if (platform.kind === "mcp") {
    return withProvider(platform, secret, paths, async (provider) => {
      const listResult = await provider.listTools()
      if (listResult.isErr()) {
        const e = listResult.error
        if (e.kind === "auth-failed") return { status: "auth-failed" }
        return { status: "unreachable", detail: formatDetail(e) }
      }
      return { status: "ok" }
    })
  }

  if (platform.kind === "custom") {
    return { status: "not-verifiable", reason: `platform kind "custom" is not verifiable` }
  }

  if (platform.kind === "http") {
    // No operator-designated verify tool concept yet (tracked for a later http
    // slice, mirroring openapi's verifyOperationId) — junction never auto-picks
    // a declared request-tool to fire (could be a POST/DELETE). Honest default.
    return { status: "not-verifiable", reason: `platform kind "http" is not verifiable` }
  }

  // Exhaustiveness guard (docs/rules/typescript.md): compile error if a new
  // PlatformKind is added without a corresponding branch above.
  const _: never = platform.kind
  return { status: "not-verifiable", reason: `platform kind "${String(_)}" is not verifiable` }
}

/** Format an UpstreamError-shaped value as a leak-safe detail string (no secret/URL). */
function formatDetail(e: { kind: string; cause?: unknown }): string {
  if (e.cause !== undefined) {
    const causeStr = e.cause instanceof Error ? e.cause.constructor.name : String(e.cause)
    return `${e.kind}: ${causeStr}`
  }
  return e.kind
}
