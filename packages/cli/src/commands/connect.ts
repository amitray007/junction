// SPDX-License-Identifier: AGPL-3.0-only
// `junction connect` — the CLI half of "connect once" for OAuth platforms
// (increment 29, slice D). Resolves an EXISTING platform (added via
// `junction platform add ... --auth-scheme oauth2`) against the OAuth
// catalog, prints the guided BYO-client registration hint, then runs either
// the browser auth-code+PKCE flow or the device-code flow and persists the
// resulting tokens as CredentialStore refs via source-runtime's
// persistOAuthTokens. `junction credential reconnect` (credential.ts) shares
// this file's flow runner for the mode:"update" path.
//
// SECURITY: client_secret is read ONLY from stdin, never a flag. Neither
// client_secret nor any access/refresh token is ever written to argv,
// stdout, stderr, a log, or --json output — persistOAuthTokens is the only
// function that ever sees the plaintext, and it only ever writes it into the
// CredentialStore.
//
// REDIRECT LIMITATION (honest, not faked): a `loopback-ephemeral` provider
// (Google) can use a per-flow OS-assigned loopback port because its OAuth app
// is registered as a desktop app against a loopback redirect with NO fixed
// port (RFC 8252 §7.3 — the authorization server matches on host, ignoring
// port). A `loopback-fixed` provider (GitHub, Slack, Microsoft, Notion,
// Atlassian, generic) requires the user to pre-register an EXACT redirect
// URI including port/path — an ephemeral CLI listener can never match that
// ahead of time. For those providers, browser-mode is NOT offered from the
// CLI: `--device` (RFC 8628) is the CLI-native headless path, and the
// browser flow lives in `junction web`'s Connect UI (slice C), which owns
// the fixed `:4321/oauth/callback` route the registration hint points at.

import { createServer } from "node:http"
import {
  type Credential,
  type CredentialStore,
  getProvider,
  listProviders,
  type NormalizedTokens,
  type OAuthProvider,
  openInBrowser,
  type Repositories,
} from "@junction/core"
import type { OAuthConnectError } from "@junction/source-runtime"
import {
  buildAuthorizeUrl,
  deviceAuthorize,
  devicePoll,
  exchangeCode,
  persistOAuthTokens,
} from "@junction/source-runtime"
import { defineCommand } from "citty"
import { consola } from "consola"
import { collectRepeatableFlag, JSON_ARG, readStdin } from "../args.js"
import { openDbAndStore } from "../db.js"
import { reportDbError, reportError } from "../format.js"

// ---------------------------------------------------------------------------
// Shared output shaping
// ---------------------------------------------------------------------------

/** The credential metadata returned on a successful connect/reconnect — never a secret. */
export interface ConnectedCredentialMeta {
  id: string
  platformId: string
  account: string
  providerId: string
}

export function credentialMeta(cred: Credential): ConnectedCredentialMeta {
  return {
    id: String(cred.id),
    platformId: String(cred.platformId),
    account: cred.profileName,
    providerId: cred.oauthMeta?.providerId ?? "",
  }
}

/** Exhaustive OAuthConnectError → human message. No default — a new kind is a compile error. */
export function formatOAuthConnectError(e: OAuthConnectError): string {
  switch (e.kind) {
    case "unknown-provider":
      return "unknown OAuth provider"
    case "state-mismatch":
      return "state mismatch — the callback did not match the pending request (possible CSRF, or a stale/duplicate callback)"
    case "exchange-failed":
      return `token exchange failed (${e.reason}${e.detail ? `: ${e.detail}` : ""})`
    case "device-pending":
      return "authorization pending"
    case "device-slow-down":
      return "polling too fast — slow down"
    case "device-denied":
      return "authorization denied by the user"
    case "device-expired":
      return "device code expired before authorization completed"
    case "device-not-supported":
      return "device flow not supported for this provider"
    case "invalid-input":
      return `invalid input: ${e.reason}`
    case "persist-failed":
      return `failed to persist tokens: ${e.cause.kind}`
    default: {
      const _: never = e
      return _
    }
  }
}

/** The guided BYO-client registration hint, shaped for --json output. */
export function registrationHintJson(provider: OAuthProvider): {
  providerId: string
  displayName: string
  registrationHint: OAuthProvider["registrationHint"]
} {
  return {
    providerId: provider.id,
    displayName: provider.displayName,
    registrationHint: provider.registrationHint,
  }
}

/** Print the guided BYO-client registration hint as a human panel. No-op under --json. */
export function printRegistrationHint(provider: OAuthProvider, json: boolean): void {
  if (json) return
  const { redirectUri, scopes, docsUrl } = provider.registrationHint
  const lines = [
    `Register an OAuth app for ${provider.displayName} and use these EXACT values:`,
    `  redirect URI:  ${redirectUri}`,
    `  scopes:        ${scopes}`,
  ]
  if (docsUrl) lines.push(`  docs:          ${docsUrl}`)
  consola.info(lines.join("\n"))
}

/**
 * Report a connect-flow error. Human mode: plain message (the registration
 * hint panel already printed once at flow start via printRegistrationHint).
 * --json: the hint travels WITH every error (per the guided-BYO UX — an
 * agent driving `connect` headlessly needs the redirect URI/scopes/docs in
 * the SAME response that tells it registration is required), alongside the
 * usual {ok:false, error}.
 */
function reportConnectError(provider: OAuthProvider, json: boolean, msg: string): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: msg, ...registrationHintJson(provider) })}\n`,
    )
    process.exitCode = 1
    return
  }
  reportError(json, msg)
}

// ---------------------------------------------------------------------------
// Device flow (RFC 8628) — the headless/--json path, and for loopback-fixed
// providers the ONLY CLI-native connect path (browser-mode is refused there).
// ---------------------------------------------------------------------------

type ConnectOutcome =
  | { ok: true; tokens: NormalizedTokens }
  | { ok: false; error: OAuthConnectError }

function sleep(ms: number): Promise<void> {
  // Test seam: the device-poll loop enforces a 5s RFC-8628 floor, so a unit
  // test driving three polls would otherwise wait 15s+ of real time. This env
  // var (set only by the test harness) collapses the wait to a microtask while
  // leaving the production floor logic (and the real interval) untouched.
  if (process.env.JUNCTION_TEST_NO_SLEEP === "1") return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How long the browser auth-code flow waits for the provider's redirect before
 * giving up. Bounds the case where the user never completes consent (closes the
 * tab / denies without a redirect / drops network) so the CLI can't hang
 * forever and the ephemeral loopback listener can't leak.
 */
const BROWSER_FLOW_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Run the full device-code flow: start → print user_code/verification_uri →
 * poll (owning the loop citty/source-runtime deliberately doesn't) until
 * authorized, denied, or expired. Progress goes to STDERR so stdout stays
 * clean for --json.
 */
async function runDeviceFlow(args: {
  provider: OAuthProvider
  clientId: string
  clientSecret: string
  scopes: string[]
  json: boolean
}): Promise<ConnectOutcome> {
  const { provider, clientId, clientSecret, scopes, json } = args

  const startResult = await deviceAuthorize({ provider, clientId, scopes })
  if (startResult.isErr()) return { ok: false, error: startResult.error }
  const { deviceCode, userCode, verificationUri, intervalSeconds, expiresInSeconds } =
    startResult.value

  if (json) {
    process.stderr.write(
      `${JSON.stringify({ ok: true, pending: true, userCode, verificationUri, expiresInSeconds })}\n`,
    )
  } else {
    consola.info(`To authorize, visit ${verificationUri} and enter code: ${userCode}`)
  }

  const deadline = Date.now() + expiresInSeconds * 1000
  // RFC 8628 §3.5 mandates a 5s minimum poll interval. The provider-supplied
  // `intervalSeconds` is only defaulted to 5 by source-runtime when the field
  // is ABSENT — an explicit `interval: 0` passes through, which without this
  // floor would busy-loop the token endpoint (sleep(0) + authorization_pending
  // continues without bumping the interval). Clamp to the 5s floor.
  let intervalMs = Math.max(intervalSeconds, 5) * 1000

  for (;;) {
    if (Date.now() >= deadline) return { ok: false, error: { kind: "device-expired" } }
    await sleep(intervalMs)

    const pollResult = await devicePoll({ provider, clientId, clientSecret, deviceCode })
    if (pollResult.isOk()) return { ok: true, tokens: pollResult.value }

    const err = pollResult.error
    if (err.kind === "device-pending") continue
    if (err.kind === "device-slow-down") {
      intervalMs += 5000 // RFC 8628 §3.5 — back off by 5s on slow_down.
      continue
    }
    // device-denied, device-expired, exchange-failed, etc. — stop polling.
    return { ok: false, error: err }
  }
}

// ---------------------------------------------------------------------------
// Browser flow — offered ONLY for redirectMode: "loopback-ephemeral"
// (Google, day-one). See the file header for why loopback-fixed providers
// are refused this path.
// ---------------------------------------------------------------------------

/**
 * Spin an ephemeral `127.0.0.1:0` listener, open the browser, wait for the
 * `?code=&state=` callback, validate `state` (CSRF — owned here, not
 * source-runtime), then exchange the code. The listener always closes
 * before this resolves.
 */
async function runBrowserFlow(args: {
  provider: OAuthProvider
  clientId: string
  clientSecret: string
  scopes: string[]
  json: boolean
}): Promise<ConnectOutcome> {
  const { provider, clientId, clientSecret, scopes, json } = args

  return new Promise((resolve) => {
    // Set once "listening" fires (below) — the callback handler reads this
    // via closure, which is safe because a real HTTP request can only arrive
    // after the server is actually listening.
    let pending: { state: string; codeVerifier: string; redirectUri: string }

    // Resolve-once + close-once guard: the flow can end via the callback, an
    // unexpected error, or the deadline timeout — whichever fires first wins,
    // and the listener is always closed exactly once (no leaked port).
    let settled = false
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: ConnectOutcome): void => {
      if (settled) return
      settled = true
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      server.close()
      resolve(outcome)
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      // Path-gate: the provider redirects to the registered redirect URI, which
      // is the bare "/" path. Any other request (a favicon fetch, a browser
      // prefetch, a port probe, a stray/duplicate request) must NOT be treated
      // as the callback — otherwise the first such request resolves the flow as
      // invalid-input and closes the single-shot listener before the real
      // ?code= callback lands. Answer 404 and keep waiting.
      if (url.pathname !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("Not found")
        return
      }

      const code = url.searchParams.get("code")
      const returnedState = url.searchParams.get("state")
      const oauthError = url.searchParams.get("error")

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(
        oauthError || !code
          ? "<html><body>Connect failed — you can close this tab.</body></html>"
          : "<html><body>Connected — you can close this tab.</body></html>",
      )

      if (oauthError) {
        finish({
          ok: false,
          error: { kind: "exchange-failed", reason: "unknown", detail: oauthError },
        })
        return
      }
      if (!code || !returnedState) {
        finish({
          ok: false,
          error: { kind: "invalid-input", reason: "callback missing code or state" },
        })
        return
      }
      if (returnedState !== pending.state) {
        finish({ ok: false, error: { kind: "state-mismatch" } })
        return
      }

      exchangeCode({
        provider,
        clientId,
        clientSecret,
        redirectUri: pending.redirectUri,
        code,
        codeVerifier: pending.codeVerifier,
      }).then(
        (result) =>
          finish(
            result.isOk() ? { ok: true, tokens: result.value } : { ok: false, error: result.error },
          ),
        (cause: unknown) =>
          finish({
            ok: false,
            error: {
              kind: "exchange-failed",
              reason: "unknown",
              detail: cause instanceof Error ? cause.constructor.name : "unknown",
            },
          }),
      )
    })

    // listen(0, ...) assigns the port ASYNCHRONOUSLY — server.address() right
    // after the call returns null/stale (observed as a literal port 0 in the
    // built authorize URL). Waiting for "listening" is required before
    // reading server.address().
    server.on("listening", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      const redirectUri = `http://127.0.0.1:${port}/`
      const { url, state, codeVerifier } = buildAuthorizeUrl({
        provider,
        clientId,
        redirectUri,
        scopes,
      })
      // Stashed in the closure the callback handler reads (`pending.state` /
      // `pending.codeVerifier` above) — the CSRF guard this flow owns.
      pending = { state, codeVerifier, redirectUri }

      // Deadline: if the user never completes consent (closes the tab, denies
      // without a redirect, drops network), no request ever hits the listener,
      // so without this the promise would never resolve and the :0 listener
      // would leak. On expiry, finish() closes the server + resolves transient.
      deadlineTimer = setTimeout(() => {
        finish({
          ok: false,
          error: { kind: "exchange-failed", reason: "transient", detail: "timeout" },
        })
      }, BROWSER_FLOW_TIMEOUT_MS)

      if (!json) consola.info("Opening your browser to complete authorization...")
      openInBrowser(url)
    })

    // A bind/listen failure must not hang the flow — resolve transient + close.
    server.on("error", (cause) => {
      finish({
        ok: false,
        error: {
          kind: "exchange-failed",
          reason: "transient",
          detail: cause instanceof Error ? cause.constructor.name : "listen-failed",
        },
      })
    })

    server.listen(0, "127.0.0.1")
  })
}

// ---------------------------------------------------------------------------
// Shared DB/store open + stdin secret read
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared args (connect + credential reconnect)
// ---------------------------------------------------------------------------

export const CONNECT_SHARED_ARGS = {
  device: {
    type: "boolean" as const,
    description: "Use the device-code flow (headless — required for loopback-fixed providers)",
    default: false,
  },
  "client-id": {
    type: "string" as const,
    description: "OAuth app client_id",
  },
  "client-secret-stdin": {
    type: "boolean" as const,
    description: "Read the OAuth app client_secret from stdin (headless/agent mode; NEVER a flag)",
    default: false,
  },
  json: JSON_ARG,
}

/**
 * Resolve the OAuth catalog provider for a platform/provider id. Platform id
 * IS the catalog provider id (v1: `platform add github --auth-scheme oauth2`
 * then `junction connect github`) — the simplest, most honest mapping; no
 * hidden id-remapping table.
 */
export function resolveProviderOrError(id: string, json: boolean): OAuthProvider | null {
  const provider = getProvider(id)
  if (provider === undefined) {
    const known = listProviders()
      .map((p) => p.id)
      .join(", ")
    reportError(
      json,
      `unknown OAuth provider "${id}" — known providers: ${known} ` +
        `(the platform id must match a catalog provider id)`,
    )
    return null
  }
  return provider
}

/**
 * Run the shared connect flow: print the registration hint, read client
 * creds, run browser-or-device, and call `persist` with the resulting
 * tokens. Reports every outcome itself (error or success) — errors go
 * through `reportConnectError` (registration hint travels with every --json
 * error) / success through `onSuccess` — callers just await it, no return
 * value to check.
 */
/**
 * Where a completed connect flow persists its tokens: a NEW credential row
 * (`create` — needs the platform + account) or an EXISTING one (`update`, i.e.
 * reconnect — repoint by id). This is the only thing that differs between
 * `junction connect` and `credential reconnect`, so runConnectFlow owns the
 * shared persist + success-output and takes just the target.
 */
export type ConnectTarget =
  | { mode: "create"; platformId: string; account: string }
  | { mode: "update"; credentialId: string }

export async function runConnectFlow(opts: {
  provider: OAuthProvider
  scopes: string[]
  device: boolean
  clientId: string | undefined
  clientSecretStdin: boolean
  json: boolean
  repos: Repositories
  store: CredentialStore
  target: ConnectTarget
}): Promise<void> {
  const { provider, scopes, device, clientId, clientSecretStdin, json, repos, store, target } = opts

  printRegistrationHint(provider, json)

  if (!clientId || clientId.trim() === "") {
    reportConnectError(provider, json, "invalid input: --client-id is required")
    return
  }
  if (!clientSecretStdin) {
    reportConnectError(
      provider,
      json,
      "invalid input: --client-secret-stdin is required (client_secret is never a flag)",
    )
    return
  }
  const clientSecret = await readStdin()
  if (!clientSecret) {
    reportConnectError(provider, json, "invalid input: client_secret (via stdin) must not be empty")
    return
  }

  // loopback-fixed providers can't run the browser flow from the CLI alone —
  // see the file header. Refuse honestly rather than open a listener that
  // can never match the provider's registered exact redirect.
  if (!device && provider.redirectMode === "loopback-fixed") {
    reportConnectError(
      provider,
      json,
      `${provider.displayName} requires an exact pre-registered redirect URI and does not support ` +
        `a CLI-only browser flow. Use --device for a headless connect, or use the "junction web" ` +
        "Connect flow (which owns the fixed :4321/oauth/callback route this provider registers against).",
    )
    return
  }

  const outcome = device
    ? provider.deviceAuthorizationUrl === undefined
      ? ({ ok: false, error: { kind: "device-not-supported" } } satisfies ConnectOutcome)
      : await runDeviceFlow({ provider, clientId, clientSecret, scopes, json })
    : await runBrowserFlow({ provider, clientId, clientSecret, scopes, json })

  if (!outcome.ok) {
    reportConnectError(provider, json, formatOAuthConnectError(outcome.error))
    return
  }

  const authMode = device ? "device_code" : "authorization_code"
  const base = {
    repos,
    store,
    tokens: outcome.tokens,
    providerId: provider.id,
    authMode,
    clientId,
    clientSecret,
    now: Date.now(),
  } as const
  const persistResult = await persistOAuthTokens(
    target.mode === "create"
      ? { ...base, mode: "create", platformId: target.platformId, account: target.account }
      : { ...base, mode: "update", credentialId: target.credentialId },
  )
  if (persistResult.isErr()) {
    reportConnectError(provider, json, formatOAuthConnectError(persistResult.error))
    return
  }
  const cred = persistResult.value
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, credential: credentialMeta(cred) })}\n`)
  } else if (target.mode === "create") {
    consola.success(
      `Connected — platform: ${target.platformId}, account: ${target.account}, id: ${String(cred.id)}`,
    )
  } else {
    consola.success(
      `Reconnected — id: ${target.credentialId}, platform: ${String(cred.platformId)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// junction connect <platform>
// ---------------------------------------------------------------------------

export const connectCommand = defineCommand({
  meta: {
    name: "connect",
    description: "Connect an OAuth platform (browser auth-code+PKCE, or --device for headless).",
  },
  args: {
    platform: {
      type: "positional",
      description:
        "Platform ID (must match a catalog OAuth provider id, e.g. google, github, slack)",
      required: true,
    },
    account: {
      type: "string",
      description: "Logical account label (e.g. work, personal)",
      default: "default",
    },
    ...CONNECT_SHARED_ARGS,
    scopes: {
      type: "string",
      description: "Additional scope (repeatable: --scopes a --scopes b)",
    },
  },
  async run({ args, rawArgs }) {
    const json = args.json ?? false
    const platformId = args.platform as string
    const account = (args.account as string | undefined) ?? "default"

    if (!platformId || platformId.trim() === "") {
      reportError(json, "invalid input: platform must not be empty")
      return
    }

    const provider = resolveProviderOrError(platformId, json)
    if (provider === null) return

    const ctx = await openDbAndStore(json)
    if (!ctx) return
    const { repos, store } = ctx

    // The platform row must already exist (added via `platform add`) and
    // declare oauth2-compatible auth — mirrors `credential add`'s
    // precondition. connect never silently creates a Platform row: platform
    // identity/kind is the operator's explicit decision via `platform add`.
    const platformResult = await repos.platforms.get(platformId)
    if (platformResult.isErr()) {
      reportDbError(platformResult.error, json)
      return
    }

    const extraScopes = collectRepeatableFlag(rawArgs, "--scopes")
    const scopes = extraScopes.length > 0 ? extraScopes : (provider.defaultScopes ?? [])

    await runConnectFlow({
      provider,
      scopes,
      device: args.device ?? false,
      clientId: args["client-id"],
      clientSecretStdin: args["client-secret-stdin"] ?? false,
      json,
      repos,
      store,
      target: { mode: "create", platformId, account },
    })
  },
})
