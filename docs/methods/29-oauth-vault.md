---
increment: 29
title: OAuth vault — connect once (auth-code + device-code, refresh loop, provider catalog)
depends_on: [28.9]            # kind matrix + verify + credential store hardening land first
soft_after: []
touches: [core, source-runtime, cli, web, ci]
parallel_group: wave-29       # A (core vault + catalog + refresh) BLOCKS; then B (connect flows) ∥ C (web) ∥ D (cli)
---

# Method File 29 — OAuth vault: "connect once"

> **The wedge.** "Connect your platform accounts once, so any agent can reach them" is junction's
> core promise. This increment delivers it for OAuth — and the user's bar is explicit and load-bearing:
> **OAuth must "just work" across providers so the user never hits "this one works but that one
> doesn't."**
>
> **The thesis (from research — two independent streams converged).** OAuth "just works" is NOT a
> library problem — it's a **provider-catalog + refresh-loop** problem. `arctic` does the
> code-exchange for ~60 providers but is deliberately thin (authorization-code only, no storage, no
> refresh scheduling) and **declines the very providers that diverge most** (Slack's
> `{"ok":false}`-at-HTTP-200, odd scope delimiters). So the "works for Google, breaks for Slack" pain
> lives in the **divergence handling**, which junction must own. Three things make it just work, all
> junction's to build:
> 1. **A Nango-shaped provider catalog** — divergence as *data, not code* (per-provider defaults +
>    a few overrides: refresh magic-params, scope delimiter, PKCE on/off, token-endpoint auth method,
>    expiry strategy, redirect mode, response quirks).
> 2. **An encrypted token vault** — access + refresh tokens as **refs** (never inline), expiry,
>    scopes, and a first-class **`needs_reauth`** state.
> 3. **A refresh loop done right** — single-flight in-memory mutex, **atomic rotation persistence**
>    (the #1 lockout bug), keep-old-refresh-if-absent, refresh-ahead + on-401 fallback,
>    `needs_reauth` on `invalid_grant`.
>
> **junction's localhost/single-user nature is a gift** — it collapses the hard parts: no
> multi-tenant isolation, no distributed lock (an in-memory `Map<credentialId, Promise>` is a
> *correct* single-flight, not a hack), the fixed loopback web port is a stable redirect URI.

---

## ⚠️ Decisions taken while the user was away (CONFIRM at the step-4 gate)

The user approved starting OAuth with the goal "all OAuth flavors just work; users don't think about
some not working." Then away for the four scope decisions — proceeded on the research-recommended
option for each; all flagged for override:

1. **Connect flows: BOTH browser auth-code+PKCE AND device-code (RFC 8628) this increment.** Avoids
   the "works on my laptop, breaks on my headless server" gap — exactly the pain to eliminate.
   Device-code is thin (POST + poll). (Alt: browser-only now, device-code next — rejected as it
   leaves headless users with a broken connect.)
2. **Client-ownership: BYO client, guided.** The user registers their OWN OAuth app per provider and
   pastes `client_id`/`client_secret`; junction makes the one-time registration painless (shows the
   EXACT redirect URI + scopes per provider). The ONLY correct model for a self-hosted single-user
   tool — most providers' ToS ban credential-sharing, and a shared client puts junction's name on the
   consent screen. (Alt: shared/hosted client — rejected on ToS + architecture.)
3. **Catalog breadth: ~6 tuned providers + generic fallback.** First-class tuned entries for Google,
   GitHub, Slack, Microsoft, Notion, Atlassian + a **generic-oauth2** entry (user supplies
   endpoints) so any standard provider works. Divergence is data; extending later is a data add.
4. **`needs_reauth` is first-class, surfaced everywhere.** A credential state like the verify
   badge: web shows a prominent **Reconnect**, CLI/agent paths return a clear "connection expired —
   run `junction connect <platform>`" rather than an opaque 401. The research calls silent breakage
   the worst UX; this turns the unavoidable eventual refresh-failure into a one-click fix.

**Also carried from research (not decisions — the correct defaults):** arctic 3.7.0 (verified
current, not deprecated) as the code-exchange engine for covered providers + its generic
`OAuth2Client` driven by the catalog for the rest; `openid-client` recorded as the escalation path if
OIDC-discovery/DCR/DPoP-heavy sources arrive later; client-credentials (`OAUTH2_CC`) + RFC-8414/OIDC
discovery + token-exchange/DPoP/mTLS/private_key_jwt left as typed catalog slots, built when a
required provider forces the issue.

---

## ⚙️ Feasibility-review corrections (folded in — the plan was buildable but 3 seams were understated)

A feasibility review verified the core architecture against the code (two-ref model, additive
migration, new-entry-path for oauth2, web-callback seam — all CONFIRMED sound) and caught four things
now fixed here:

- **F1 — on-401 reactive refresh has no seam where I first put it.** The 401 from a real API call
  surfaces as the return of `provider.callTool` **inside `@junction/core`'s `proxy.ts` (`callTool`,
  ~proxy.ts:233)** — a layer with NO store/repos/arctic, so it can't refresh there. **Decision:**
  **refresh-ahead (expiry-buffer) is the PRIMARY path** and slots cleanly into `resolve-provider.ts`
  as planned. **On-401 reactive refresh is a SECONDARY path built at the source-runtime seam** where
  the resolver lives — i.e. wrap the call at `adaptToMcpHandlers` / the serve handler in
  source-runtime/cli (which HAS the resolver + store): on an `auth-failed`/401 from `callTool`, run
  ONE `refreshIfExpired(force:true)` + retry, then give up to `needsReauth`. **If the on-401 seam
  proves messy at build, it drops to a fast-follow — refresh-ahead + `needsReauth`-on-`invalid_grant`
  is sufficient for "connect once" on its own.** (Do NOT try to hook 401 inside core's proxy.)
- **F2 — single-flight Map placement is load-bearing, not a builder aside.** The multi-account wedge
  allows **many SourceRefs → one credentialId** (`schema.ts:60`), and `listTools` fans out
  concurrently (`proxy.ts:148`), so one `listTools` on a profile with two sources sharing an OAuth
  credential fires **two concurrent refreshes on the same credentialId** — the exact rotation race.
  **Decision (mandatory, not optional):** the single-flight map is a **module-level singleton in
  source-runtime, keyed by `credentialId`** (`Map<string, Promise<Tokens>>`), so ALL resolve paths in
  the process share it. The single-flight regression test MUST reproduce the real concurrency source:
  a `listTools`/fan-out where two enabled sources reference one OAuth credential → assert exactly ONE
  provider refresh call, both resolves get identical tokens.
- **F3 — `openInBrowser` is CLI-private (`web.ts:89`, not exported).** Slice B/D can't "reuse" it.
  **Fix:** extract a `openInBrowser` util to core (or a shared util) FIRST; collapse the CLI's copy
  into it (DRY, rule-of-three: cli web + connect + device all need it).
- **F4 — "core stays HTTP-free" is convention, not a depcruise rule.** `depcruise` only bans in-repo
  edges (`core-imports-nothing-in-repo`); nothing stops `core` importing `arctic`/`undici`/`node:http`
  today. **Fix:** do NOT cite "depcruise 0 proves core HTTP-free." Add a **new depcruise rule** that
  bans `packages/core` from importing `arctic` + the HTTP libs (make the invariant mechanical, like
  the inc-28 `source-runtime-not-mcp-server` rule), positive-controlled with a planted import. The
  `junction-package-boundary` reviewer is the backstop; the new rule is the gate.
- **F5 — scope honesty: slice A is itself ~a full increment.** Split A into **A1 (vault model +
  catalog + kind-compat un-gate — PURE, no HTTP)** and **A2 (the refresh engine + single-flight +
  atomic rotation)**. A1 is a clean self-contained first landing. **`connect a REAL provider
  end-to-end` proof-of-done spans multiple build sessions** — this is a multi-session increment; plan
  it that way, land A1 first. **arctic is NOT installed** — slice B must `pnpm add arctic` and
  **confirm its real surface** (per-provider classes + generic `OAuth2Client`, PKCE, refresh-where-
  supported, `OAuth2Tokens` accessors throwing on absent fields, device-code absent) **before B's
  scope is fixed**; if the surface diverges from research, B reshapes.
- **F8 caveat — the pending-auth `state → {codeVerifier, providerId, ...}` record** lives in an
  **in-memory `Map` in the serve process** (same-process, single-user — correct; a DB table is
  overkill). The `/oauth/callback` is a **file-route loader** (runs server-side via `getRequest()` —
  NOT a `createServerFn`, no `ServerRoute` primitive exists in the installed TanStack) — so the
  persist logic MUST be **idempotent/single-use** (consume the state record on first use; the loader
  can re-run on client nav).

---

## Part 1 — Spec (what & why)

### The data model (additive — no destructive migration)

`oauthMeta` is already a nullable JSON TEXT column (`db/schema.ts:34`), reserved day-one for exactly
this (`credential.ts:21-38`). Two token secrets (access + refresh) can't share one `secretRef` (the
store is a flat `ref→string` map), so:

- **`OAuthMetaSchema` gains** (additive, `z.object` strips unknowns → old rows parse): `refreshTokenRef`
  (a second minted ULID resolving through `CredentialStore`, NEVER a raw token — the reserved
  invariant), `expiresAt` (already there; now populated), `scopes` (already there), `providerId`
  (the catalog key), `authMode` (`authorization_code | device_code | client_credentials`),
  `clientIdRef` + `clientSecretRef` (BYO client creds stored as refs too — the secret is a secret),
  `needsReauth: boolean`, `obtainedAt`. Access token stays in the credential's existing `secretRef`.
- **Migration 0009 (additive):** ONE of — (a) store all of the above in the existing `oauth_meta`
  JSON (zero DDL, lowest friction, the day-one intent) — **CHOSEN default**; OR (b) typed columns if
  queryability is wanted. Builder uses (a) unless a query need emerges; if (a), 0009 may be
  unnecessary (confirm — the reserved column already exists). A `token_refreshes` audit table is
  **deferred** (audit is inc 30). **If any DDL is needed it's drizzle-generated (never hand-authored),
  journal `when` > current max (0008).**
- **New repo method** `setOAuthTokens(id, {accessTokenRef, refreshTokenRef, expiresAt, scopes, needsReauth})`
  — atomic write of the token refs + expiry, mirroring `setSecretRef`/`setVerifyState`
  (`credentials.ts:104-147`).

### The provider catalog (`@junction/core` — the "just works" heart)

New `packages/core/src/oauth/catalog.ts` — a Nango-shaped registry. Each entry is **mostly defaults +
the handful of overrides that provider needs**. The override taxonomy (only what day-one providers
require; the rest are typed slots defaulting sensibly):

```ts
interface OAuthProvider {
  id: string                          // "google" | "github" | "slack" | ... | "generic"
  displayName: string
  // Endpoints (catalog-supplied; generic = user-supplied)
  authorizationUrl: string | ((cfg) => string)   // fn for {subdomain}-style connection_config
  tokenUrl: string | ((cfg) => string)
  deviceAuthorizationUrl?: string     // RFC 8628 — presence = device-code supported
  // Divergence knobs (default → override only where a provider needs it):
  pkce: "S256" | "disabled"           // default S256; a few providers break on PKCE
  scopeSeparator: " " | "," | "+"     // default " "
  authorizationParams?: Record<string,string>   // Google: {access_type:"offline", prompt:"consent"}; MS scope: offline_access
  tokenAuthMethod: "client_secret_basic" | "client_secret_post" | "none"  // default basic; GitHub=basic, some=post
  bodyFormat: "form" | "json"         // default form
  expiryStrategy: "expires_in" | "expires_at" | "none"  // GitHub OAuth App = none (never expires)
  parseTokenResponse?: (raw) => NormalizedTokens        // Slack: reject {ok:false}-at-200; field remap
  redirectMode: "loopback-fixed" | "loopback-ephemeral" // Google desktop = ephemeral; SaaS = fixed registered
  defaultScopes?: string[]
  registrationHint: { redirectUri: string; scopes: string; docsUrl: string }  // the "guided BYO" text
  supportsRefresh: boolean            // GitHub OAuth App = false (no refresh; token never expires)
}
```

**Day-one tuned entries + the divergence each encodes** (all research-cited):
- **google** — `authorizationParams:{access_type:offline, prompt:consent}` (else no refresh token),
  keep-old-refresh-if-absent (handled in the refresh loop), `redirectMode: loopback-ephemeral`
  (desktop app), device-code supported.
- **github** — model **both** GitHub OAuth Apps (`supportsRefresh:false`, `expiryStrategy:none` —
  token never expires, no refresh) AND GitHub Apps (rotate, invalidate-old-immediately);
  `tokenAuthMethod: client_secret_basic`. Catalog carries two entries or a variant flag.
- **slack** — `parseTokenResponse` rejects `{ok:false}` at HTTP 200 (arctic won't); refresh only if
  the app enabled rotation; `redirectMode: loopback-fixed`.
- **microsoft** — `authorizationParams` includes `scope: offline_access` (else no refresh);
  device-code supported.
- **notion / atlassian** — `redirectMode: loopback-fixed` (exact-registered redirect), Atlassian
  `connection_config` `{subdomain}` for site URL.
- **generic** — user supplies `authorizationUrl`/`tokenUrl`/scopes; sensible defaults; the escape
  hatch so ANY standard provider works.

The catalog is **pure data + pure functions in core** (no HTTP, no I/O) — testable in isolation, and
core stays HTTP-free. Provider quirks are a data table, not branching code.

### The connect flows (`@junction/source-runtime` or a new `@junction/oauth` lib — the composition of arctic + catalog)

**Where OAuth code lives (BOUNDARY DECISION):** the **token store + catalog + refresh loop** are pure
enough to live in **core** (no HTTP: the catalog is data; the token model is schema/repo). The
**HTTP-touching parts** (the actual authorize-URL build via arctic, the code→token exchange, the
device-poll, the refresh HTTP call) compose arctic + fetch → they live in **`@junction/source-runtime`**
(already the "runs HTTP against sources" lib, already a web + cli dep) OR a dedicated **`@junction/oauth`**
lib. **Recommendation: `@junction/source-runtime`** (it already owns buildProvider/verifyCredential's
HTTP; adding OAuth keeps the composition-root pattern; avoids a 3rd lib). Builder confirms the seam;
core holds catalog+model+refresh-policy (pure), the lib holds the arctic/fetch calls. arctic is a dep
of that lib only.

**Browser authorization-code + PKCE:**
1. `junction connect <platform>` (CLI) or web "Connect" → resolve the platform's OAuth config (catalog
   entry + BYO client creds) → arctic (or generic client) builds the authorize URL with `state`
   (CSRF), PKCE `S256` `code_verifier`, catalog `authorizationParams` + scopes → open the browser
   (the **extracted** shared `openInBrowser` util — see F3; the CLI's private copy collapses into it).
2. **Callback listener:** two modes per `redirectMode` — **loopback-ephemeral** (CLI spins a transient
   `http.createServer` on `127.0.0.1:0`, OS-assigned port; Google desktop) OR **loopback-fixed** (the
   already-running `junction web` server's new `/oauth/callback` route at the registered fixed port
   4321; SaaS). The web route validates `state` against a server-side pending-auth record (the code
   arrives via a top-level browser nav, NOT a guarded server-fn — `state` is the CSRF guard).
3. On `?code=`: exchange (arctic `validateAuthorizationCode` or generic) → normalize via the catalog's
   `parseTokenResponse` → persist access + refresh as refs + expiry + scopes + `needsReauth:false`.

**Device authorization grant (RFC 8628):** for headless/`--json`. `junction connect <platform>
--device` → POST the device endpoint → print `user_code` + `verification_uri` (JSON in headless) →
poll the token endpoint at the returned interval until authorized/expired. Same token persistence.
Only offered for catalog entries with `deviceAuthorizationUrl`.

### The refresh loop (the correctness heart — `docs/behaviours` correctness-over-speed applies hardest here)

Hook: `resolve-provider.ts:126-148` (the serve/debug hot path) + `resolveCredentialSecret` (CLI debug
path) — both already async `ResultAsync`, so `await refreshIfExpired(...)` slots in **after** fetching
the credential row, **before** `store.get`/`buildProvider`. The injected value is always the *current*
access token; providers need NO change (they inject `secret.value` as bearer).

`refreshIfExpired(credential, catalog, store, repos)` — the invariants (each a named regression test):
- **Expiry check with a buffer** (30–60s early) using `oauthMeta.expiresAt`; `expiryStrategy:none` →
  never refresh (GitHub OAuth App).
- **Single-flight:** an in-memory `Map<credentialId, Promise<Tokens>>` — concurrent callers await the
  SAME in-flight refresh, never launch a second (the rotation race). Single-process localhost → this
  is correct, not a shortcut.
- **Atomic rotation persistence** (mirror `rotateCredential`'s write-new-ref-first → repoint → delete-old
  with rollback): fetch refresh token → provider refresh call → write NEW access token to a fresh ref
  → write the (possibly rotated) refresh token to a fresh ref → repoint the DB `setOAuthTokens` in ONE
  step → best-effort delete old refs. **Never overwrite a good refresh token with a partial/failed
  result.**
- **Keep-old-refresh-if-absent:** Google may return NO refresh token on refresh → **retain the prior
  refreshTokenRef**, never null it.
- **On-401 fallback:** providers surface `auth-failed` (`connect.ts:69`); a call that 401s despite a
  "valid" token triggers one reactive refresh + retry (clock skew / early revocation).
- **`invalid_grant` → `needsReauth:true`** persisted; the resolution returns a clear error, NOT a
  silent skip. Surfaced as the Reconnect state everywhere.

### Surfaces

- **CLI:** `junction connect <platform> [--account <name>] [--device] [--scopes ...] [--json]` — the
  BYO client creds prompted/piped (client_id/secret via `--client-id`/`--client-secret-stdin`), the
  guided registration hint printed (redirect URI + scopes to register), browser or device flow,
  token persisted. `junction credential reconnect <id>` re-runs connect for a `needsReauth` credential.
  `credential list` shows OAuth state (Connected / Needs reconnect / Expiring). Secret/token NEVER
  printed.
- **Web:** an "Add OAuth platform / Connect" flow — pick provider from the catalog, paste BYO client
  creds, the guided registration panel (exact redirect URI + scopes, copy-able), "Connect" → browser
  → `/oauth/callback` → done. Credentials page: `needsReauth` → a prominent **Reconnect** button;
  `expiresAt` wires the reserved **Expiring** badge (the inc-28.9 dead wire — now live). Metadata-only;
  tokens/refs/client-secret NEVER in any response/DOM/SSR (the inc-24/28 leak discipline).
- **kind-compat:** un-gate `oauth2` (`kind-compat.ts:123` returns false → allow for OAuth platforms);
  `kindsForOpenApiAuth` oauth2 → `["oauth2"]` (was interim `["bearer"]`); update
  `compatibleCredentialKinds` matrix. `AddCredentialInput.kind` no longer excludes oauth2 (OAuth uses a
  new `connect`/`addOAuthCredential` entry path, not the plaintext-secret `addCredential`).
- **Platform auth descriptor:** the `OpenApiAuthSchema.oauth2` variant (currently empty,
  `openapi-connection.ts:73`) gains `{ providerId, clientIdRef?, scopes, redirectMode }` etc. (the
  connection-level OAuth config; the tokens live on the Credential). MCP http gains an oauth2 variant.

### Security / robustness invariants (the review gate checks these — this is a security-critical increment)

- **Tokens + client secret are REFS, never inline** — access token in `secretRef`, refresh token in
  `refreshTokenRef`, client_secret in `clientSecretRef`, all resolving through `CredentialStore`
  (keyring/AES). NEVER stored in `oauth_meta` JSON, a DB column, argv, logs, errors, tool results, or
  any web response/DOM/SSR. (The whole inc-24/28/28.9 leak discipline + gates apply; the adversarial
  sweep is mandatory QA.)
- **PKCE `S256`** default; `state` CSRF-validated on every callback (the code arrives via unguarded
  browser nav). `code_verifier` + `state` are per-flow, server-side, single-use, expiring.
- **Refresh loop correctness** (above) — the atomicity + single-flight + keep-old-refresh invariants
  are the difference between "connect once" and "permanent lockout." Each is a regression test.
- **Callback is loopback-only** — the `/oauth/callback` route + the CLI ephemeral listener bind
  `127.0.0.1` only; the existing Host guard covers the web route. The `state` param is the CSRF guard
  (the callback isn't a server-fn).
- **BYO client secret at rest** — the user's `client_secret` is a secret → stored as a ref, encrypted,
  never returned. The guided registration is the only place the redirect URI/scopes (non-secret)
  appear.
- **arctic error opacity** — arctic's `OAuth2Tokens` accessors THROW on absent fields (e.g. no refresh
  token) → catch and map to typed outcomes, never let a raw throw carry a token into a log.
- **core stays HTTP-free** — catalog + token model + refresh *policy* in core (pure); the arctic/fetch
  calls in source-runtime. **Enforced mechanically by a NEW depcruise rule** (`core-not-http`: bans
  `packages/core` importing `arctic`/`undici`/`node:http`/`node:https`) — NOT merely by the existing
  in-repo rule (which wouldn't catch a core→arctic edge). Positive-controlled with a planted import.

### Proof of done

- `pnpm verify` with tests:
  - **Catalog** (core, pure): each tuned provider's overrides correct; generic entry; scope-separator /
    authorizationParams / expiryStrategy / redirectMode per provider; Slack `parseTokenResponse`
    rejects `{ok:false}`-at-200 + a happy parse; keep-old-refresh semantics encoded.
  - **Refresh loop** (the five classic bugs as explicit regression tests): atomic rotation persistence
    (crash-between-refresh-and-write doesn't lose the token); **single-flight tied to the REAL
    concurrency source** — a `listTools` fan-out where two enabled sources share one OAuth credentialId
    (`schema.ts:60` many-SourceRef→one-credential) fires ONE provider refresh, both resolves get
    identical tokens (not just an abstract "two concurrent refreshes"); keep-old-refresh-if-absent
    (Google no-refresh-token response → prior ref retained); `expires_in`-absent → non-expiring not
    expired; `invalid_grant` → `needsReauth` set + clear error. **On-401 reactive refresh** (if built
    this increment, not fast-follow) → one refresh+retry at the source-runtime seam.
  - **New depcruise `core-not-http` rule** fires on a planted `core → arctic` (or `node:http`) import
    (positive control) and passes clean on the real tree.
  - **Connect flows:** auth-code exchange (mocked provider) → tokens persisted as refs (assert no raw
    token in DB / oauth_meta); device-code poll → authorized/expired/slow-down paths; `state` mismatch
    → rejected; PKCE verifier round-trips.
  - **Resolution:** an expired OAuth credential auto-refreshes before injection; a `needsReauth`
    credential returns the clear error; a non-expiring one never refreshes.
  - **Web:** connect flow builds the right authorize URL; `/oauth/callback` validates state + persists;
    `needsReauth`→Reconnect + `expiresAt`→Expiring badges; **metadata-only** (JSON-stringify negative
    tests for token/refreshTokenRef/clientSecret + the `web:leakcheck` deny-list).
  - Migration (if any DDL) staged cross-version test; else assert the `oauth_meta` JSON round-trips the
    new fields on old rows.
- `pnpm build` · `pnpm depcruise` 0 (arctic is source-runtime's dep; core imports nothing new
  in-repo) · `pnpm dup` under threshold · SPDX on new files.
- **MANUAL QA (orchestrator, real artifacts — this is the "just works" proof):** connect a REAL
  provider end-to-end locally (GitHub is the easiest BYO — register an OAuth app, paste creds, browser
  flow, token stored) → drive a real API call through the connected credential (probe/call from inc 28)
  → force a refresh (expire the token) → confirm silent auto-refresh → revoke the refresh token
  provider-side → confirm `needsReauth` + the Reconnect path works. Repeat with a second provider of a
  DIFFERENT divergence class (e.g. Google — refresh magic-params + ephemeral redirect) to prove "just
  works across providers." **Adversarial sweep:** access/refresh token + client_secret absent from
  DB/oauth_meta/DOM/SSR/HAR/logs/client-bundle. Device-code drive on a "headless" invocation.

### Out of scope (record in `docs/futures/`)

- **Client-credentials (`OAUTH2_CC`)**, **RFC-8414/OIDC discovery auto-fill**, **token-exchange
  (8693)**, **DPoP (9449) / mTLS (8705)**, **private_key_jwt (7523)** — typed catalog slots left;
  built when a required provider forces it → `revisit-when.md`.
- **`token_refreshes` audit table** — audit is inc 30; the per-key/credential attribution consumes it.
- **Multi-process / distributed refresh lock** — junction is single-process; in-memory single-flight
  is correct until it isn't → `revisit-when.md` (escalate to `proper-lockfile`, already in stack).
- **`openid-client` engine swap** — escalation if OIDC-discovery/DCR/DPoP-heavy sources arrive →
  `deprecations.md` (arctic = auth-code-only is a known, accepted limit).

---

## Part 2 — Implementation (wave)

```
A1 (BLOCKING, pure core)          A2 (BLOCKING, refresh engine)      B (connect, source-runtime)   C (web)              D (cli)
──────────────────────────        ───────────────────────────        ──────────────────────────    ────────────────     ────────────
provider catalog (pure data+fns)  refreshIfExpired policy (pure)     pnpm add arctic + CONFIRM      connect flow + guided junction connect
OAuthMetaSchema extension         single-flight singleton (src-rt)   surface FIRST                 registration panel   (browser + device)
setOAuthTokens repo method        atomic rotation (rotate-shaped)    authorize URL, code exchange, /oauth/callback loader credential reconnect
kind-compat un-gate oauth2        keep-old-refresh, expiry+buffer    device-poll, refresh HTTP     (state Map, idempotent) list OAuth state
oauth2 auth descriptor            on-401 SECONDARY seam (src-rt      call → token persist          needsReauth Reconnect --json/device path
openInBrowser util extract        wrap of callTool) or fast-follow                                 + Expiring badge live
new depcruise rule (core↛arctic)
```

- **A1 lands first, alone** (pure: catalog + model + un-gate + the browser util + the depcruise rule).
  `pnpm verify`, **commit-to-lock** (the inc-26 lesson). Self-contained; no HTTP.
- **A2** = the refresh engine (pure policy in core + the single-flight singleton + the store/repo
  atomic writes in source-runtime). Blocks B/C/D. **Slice A (A1+A2) is ~a full increment on its own;
  this is a MULTI-SESSION increment — land A1, then A2, then fan out.**
- **B is coupled to A2** (composes the refresh engine + catalog into arctic/fetch); it installs arctic
  and **confirms the surface before scoping**. Then B (source-runtime) ∥ C (web) ∥ D (cli) — disjoint
  files. Integrate serially in one tree, `pnpm verify` after each. Reviews per-slice, parallel.

### Reviewers (per slice — this is a security + correctness increment; heavy gate)

- A: `junction-credential-security` (LEAD — tokens/client-secret as refs, never inline; refresh
  atomicity; no leak) · `junction-package-boundary` (core stays HTTP-free; arctic in the lib not core;
  catalog pure) · `ce-correctness-reviewer` (the five refresh-loop classic bugs; single-flight
  correctness; keep-old-refresh) · `ce-data-migration-reviewer` (0009 additive / oauth_meta JSON
  round-trip) · `compound-engineering:ce-adversarial-reviewer` (it's auth + tokens — construct the
  lockout/leak/CSRF failure scenarios).
- B: `junction-credential-security` + `ce-correctness-reviewer` (arctic error-opacity; state/PKCE;
  device-poll edge cases).
- C: `junction-web-reviewer` (LEAD — metadata-only, boundary, badges, callback state-guard, the
  browser-nav-not-server-fn seam) · `junction-credential-security`.
- D: `junction-clean-code-reviewer` · `ce-correctness-reviewer` (secret never in argv/output; device
  --json contract).
- Then `/ce-simplify-code` per diff.

## End-of-increment report (per CLAUDE.md) — template

**Visually testable — YES:** `junction connect github` (or the web Connect flow) → browser consent →
the credential shows **Connected**; an agent call through it works; when it expires it silently
refreshes; when the refresh token is revoked it shows **Reconnect**. Prove a SECOND provider of a
different divergence class works identically ("just works across providers").

## User test gate

```bash
pnpm build
JUNCTION_HOME=/tmp/jt29 node packages/cli/dist/index.js init
# BYO: register a GitHub OAuth app (junction prints the exact redirect URI + scopes to use), then:
JUNCTION_HOME=/tmp/jt29 node packages/cli/dist/index.js connect github --account work \
  --client-id <id> --client-secret-stdin   # browser opens → consent → token stored
JUNCTION_HOME=/tmp/jt29 node packages/cli/dist/index.js credential list   # → github · work · Connected
# put it in a profile + call a real GitHub API through it (inc-28 probe/call); force expiry → auto-refresh.
# headless box: add --device → prints user_code + verification_uri, poll to completion.
```
Approve → increment 30 (Audit — pino; consumes per-key/credential attribution + the token-refresh events).
