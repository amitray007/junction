---
increment: 38
depends_on: [36]
soft_after: [37]
touches: [core, source-runtime, web]
parallel_group: A
---

# Increment 38 — Inline OAuth catalog-connect bind

> **Why this exists (a re-plan):** planning Gmail (inc 39) surfaced a SYSTEMIC gap
> — junction's catalog one-click **Connect cannot bind a source for ANY oauth2
> surface**. The oauth2 path mints a credential but never creates the bound
> platform (source) row → no tools. This blocks every OAuth-only app
> (Gmail/Calendar/Drive). GitHub/Slack ship only because they also accept a
> static PAT. **User decision (2026-07-11): fix the gap first.** This is
> inc-30.11's deferred "inline oauth2 connect" (`revisit-when.md` row 8).

## What / why

Make the catalog's oauth2 **Connect** flow create-and-bind the source across the
OAuth authorize→callback round-trip: carry the surface's assembled `Platform`
through pending-auth, and at callback time `platforms.upsert` it **before**
`credentials.create`. The runtime ALREADY refreshes + injects oauth2 tokens into
any source's bearer kind-agnostically (`resolve-provider.ts:131`) — only the
catalog-connect **bind** is missing. After this, an OAuth-only app connects in
one guided flow (BYO client creds once → authorize → a working, tool-serving
source).

**Non-negotiable:** minimal blast radius on shipped inc-29 auth. The three
must-stay-working flows below are untouched by construction (optional,
create-mode-only payload).

## The verified seam (from recon — build against these)

- **FK HARD RULE:** `credentials.platformId` is `NOT NULL → platforms.id`
  (`db/schema.ts:30-32`). So `platforms.upsert` MUST run **before**
  `credentials.create`.
- **pending-auth store** (`web/src/server/pending-auth.server.ts`): in-memory
  `Map`, same-process, single-use, TTL 10min. Already carries
  `intent: {mode:"create", platformId, account} | {mode:"update", credentialId}`.
  Extend the create-intent to also carry the assembled `Platform` + `displayName`
  (server-memory only — not client-controlled, trustworthy for tampering).
- **The bind mechanism to mirror:** `connect-from-catalog.ts`
  `assemblePlatform(platformId, displayName, platformInput)` (→
  `addMcpPlatform`/`addHttpPlatform`/`addOpenApiPlatform`/… returns an in-memory
  `Platform`, credential-independent) + `checkCollision(repos, platformId, kind)`.
- **The D1 edit site:** `persistOAuthTokens` `mode:"create"` branch
  (`source-runtime/oauth-connect.ts:422-535`) — it has a guarded `work()` closure
  with rollback wiring (`written[]` + `cleanup(store, written)` on every failure
  branch; the "never reject" outer try/catch). `credentials.create` is at ~:530.
- **The D2 payload site:** `startConnect` / `StartConnectInput`
  (`web/src/server/oauth-connect.server.ts:39-76`) — already requires
  `{providerId, clientId, clientSecret, scopes, account, platformId}` and stashes
  into `putPending`'s intent (~:70).
- **The short-circuit to replace:** `connect.server.ts:106-108` (oauth2 →
  `{handoff:"/credentials"}`) + `planConnect`'s oauth2 short-circuit
  (`build-recipe.ts:194-196`, which returns before building `platformInput`).

## Decisions (Fable-decided — implement exactly)

### D1 — the platform-build fires INSIDE `persistOAuthTokens` (option b, refined)

- The **web layer** (`completeOAuthCallback`) assembles the `Platform` via
  `assemblePlatform(...)` (pure, credential-independent) from the pending-auth
  payload, then passes that **ready `Platform`** into `persistOAuthTokens` as an
  **OPTIONAL** arg: `PersistOAuthTokensArgs` gains
  `platformBuild?: { platform: Platform; preExisting: boolean }` — pass the
  assembled `Platform` plus the collision result (`preExisting` = the platform
  already existed with a matching kind), so the fn knows whether it created the
  platform (drives the D3 cleanup decision).
- `persistOAuthTokens` `mode:"create"`: when `platformBuild` is present, do
  `repos.platforms.upsert(platform)` as the **first guarded DB step** (capture
  `platformWasCreatedHere` = the platform did NOT pre-exist, from the collision
  check), THEN the existing `credentials.create`. When ABSENT (raw `/credentials`
  flow — platform pre-exists), the path is **byte-identical to today**.
- Rationale: co-located rollback (D3) in the one guarded closure; keeps FK-ordered
  transactional logic OUT of the web layer (core-is-pure/edges-thin); the assemble
  helpers already live in source-runtime (no boundary violation); the *assembly*
  (catalog-shape knowledge) stays in the catalog-connect layer, `persistOAuthTokens`
  gets only the generic "upsert this platform before the credential" job.

### D2 — BYO client creds collected once in the guided Connect dialog

- The connect-panel's **guided oauth2 mode** (inc 36) collects clientId /
  clientSecret / scopes (the one-time BYO-app registration — already the approved
  design). Scopes come from the surface's declared `auth[oauth2].scopes` or the
  provider `defaultScopes`.
- These flow into `startConnect` **together with** the surface's platform payload.
  `startConnect` already requires the BYO triple; 30.11 punted precisely because
  the handoff carried only `providerId`. The credential's `oauthMeta` stores
  `clientIdRef`/`clientSecretRef`, so reconnect reuses them (no re-typing).
- **Collision pre-check at `startConnect`, BEFORE the Google redirect:** run
  `checkCollision(repos, platformId, platformInput.kind)`. If the platformId
  exists with a conflicting kind, FAIL before sending the user to Google — never
  strand a completed OAuth grant with nowhere to bind. **Re-check at callback**
  too (state may change during the round-trip).
- **Replace the oauth2 short-circuit:** `connect.server.ts`'s oauth-handoff branch
  (and `planConnect`) must now, for a catalog oauth2 surface, PRODUCE the surface's
  `PlatformInput` + `displayName` (planConnect can compute it — it just currently
  returns before doing so) and route into this inline flow instead of the bare
  `/credentials` deep-link. The `ConnectPlan` type + `toConnectPlanPreview`'s
  `oauth2-handoff` kind widen to carry the platformInput (contained type change).

### D3 — orphan-platform acceptable; match `confirmThenAdd` + best-effort cleanup

- Precedent: `confirmThenAdd` (`connect-from-catalog.ts:318-336`) does
  `platforms.upsert → writeCredential` with NO platform rollback on credential
  failure — shipped + deliberate. Inc-38 makes oauth2 match the token path's
  semantics (don't invent a stronger guarantee for oauth2 only).
- True cross-table atomicity is **unachievable** anyway (the `CredentialStore`
  keyring/file is not transactional with SQLite) and disproportionate.
- **Bounded hardening:** on the `credentials.create` failure branch, if
  `platformWasCreatedHere` (this call did the upsert AND the platform didn't
  pre-exist), attempt a **best-effort `platforms.delete(platformId)`** alongside
  the existing `cleanup(store, written)`, in the SAME guarded closure. Best-effort
  = log-and-continue on delete failure; NEVER let cleanup failure mask the
  original error. Strictly better than `confirmThenAdd` (which has no platform
  cleanup) at trivial cost.
- **Do NOT delete a pre-existing platform** (collision found an existing same-kind
  platform → this call only added the credential → leave the platform intact,
  mirror `confirmThenAdd`'s `existing` branch).
- The stable deterministic `platformId` (`{app}`/`{app}-{kind}`) + `upsert` makes
  any orphan **inert** (a platform with no credential serves no tools — skipped by
  `resolve-provider.ts:92-117`) and **self-healing on retry** (idempotent
  re-upsert). Document the accepted residual in `docs/futures/gotchas.md`.

## Must stay working (verify each — untouched by construction)

1. **Raw `/credentials` OAuth flow** (`ConnectOAuthDialog`, user selects an
   existing platform from a dropdown) — no surface payload → `platformBuild`
   absent → path identical to today.
2. **Reconnect / re-auth (`mode:"update"`)** — the `platformBuild` field is on the
   CREATE-args only; update never sees it, never creates a platform.
3. **CLI `connect`** (`cli/commands/connect.ts:632-640`) — explicitly refuses to
   auto-create platforms (operator's explicit `platform add` decision). It omits
   the optional payload → `persistOAuthTokens` creates no platform for it.

## Proof-of-done

- `pnpm verify` green.
- **Orchestrator QA drives the REAL flow end-to-end against real GitHub OAuth**
  (GitHub has an oauth2 surface AND is the shipped app — the honest dogfood; do
  NOT wait for Gmail): from `/app/github`, guided oauth2 Connect on a surface →
  BYO client creds → authorize → callback → assert a **bound platform row + an
  oauth2 credential** exist and the surface flips to **connected with tools**
  (probe lists tools). Then assert the three must-stay-working flows still work
  (raw `/credentials` connect against a pre-existing platform; a reconnect; CLI
  connect refuses auto-create). Collision pre-check fires before redirect.
  Orphan-cleanup: force a credential-create failure after upsert, assert the
  just-created platform is best-effort-deleted (and a pre-existing one is NOT).
- **Adversarial:** no clientSecret/token/refresh-token reaches the DOM/SSR/logs;
  the credential is stored (keyring/AES), plaintext absent from `junction.db`.
- Reviewers: **junction-credential-security (LEAD** — this touches the OAuth vault
  + secret handling + the new store payload), junction-package-boundary (the
  web→assemble→source-runtime composition; no reverse dep), junction-clean-code
  (single-purpose of the widened `persistOAuthTokens`; the optional-payload
  discipline), ce-correctness (the FK ordering, the create-mode-only guard, the
  collision recheck, the cleanup branch).

## Not in scope

Gmail/Calendar authoring (39/40 — they CONSUME this). Making the CLI auto-create
platforms (deliberately unchanged). True cross-table atomicity (unachievable +
disproportionate). Any change to reconnect/update semantics. The remote-MCP
Dev-Preview surface (still gated on GA).

## Unblocks

After this ships, `revisit-when.md` row 8 ("inline catalog-seeded oauth2 connect")
is RESOLVED. Gmail (39) can ship its HTTP-template surface as a real, connectable
oauth2 surface; Calendar (40) likewise. Strike/annotate row 8.
