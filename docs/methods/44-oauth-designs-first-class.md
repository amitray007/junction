---
increment: 44
title: Phase 3 — OAuth designs first-class + credentials shed providerId
depends_on: [42, 43]
soft_after: []
touches: [core/oauth, core/schema, core/db, source-runtime, web]
parallel_group: A
---

# 44 — Phase 3: OAuth designs first-class + credentials shed providerId

North star: `docs/specs/2026-07-17-credential-platform-normalization.md`. The final, hardest
phase. Fully normalizes: **credential = pure secret; OAuth provider = global reusable design;
platform = the binding.** It re-points OAuth refresh at the platform's design instead of the
credential's denormalized `providerId`. **Data-migration reviewer + credential-security reviewer
required.**

> **Design authority.** The scope, schema deletions, and deferrals below are the ruling of a
> Fable product-owner subagent (per the user's standing "whatever Fable decides, we execute"
> directive), informed by an Opus OAuth-format-diversity research pass. The research finding that
> reshaped this file: junction's `OAuthProvider` bet (divergence-as-data) is sound and covers ~85%
> of real providers, BUT three schema surfaces are **inert dead code** — arctic (the runtime
> executor) ignores `tokenAuthMethod` and `bodyFormat`, and the `(cfg)=>string` per-tenant URL form
> cannot refresh. This increment **deletes** that dead surface rather than building UI on top of it.

## What / why

After Phases 1–2 credentials are standalone secrets bound to platforms, but OAuth credentials
still carry `oauthMeta.providerId` — a denormalized copy of what the app/platform already
declares (`app.auth[].providerId`). This phase removes that last linkage so credentials are
*completely* free of provider/platform intervention (the user's requirement), and makes the
global OAuth designs a first-class, manageable thing.

## The load-bearing change: refresh re-sourcing

**Feasible today** — `resolve-provider.ts` resolves the `platform` for a source *before* the
credential, so the platform is in hand at refresh time. Re-point refresh:

- `oauth/refresh.ts` currently reads `credential.oauthMeta.providerId`. Change it to accept the
  `providerId` sourced from the **platform** (the caller in `resolve-provider` passes
  `platform`'s declared provider). The credential keeps only token material (access/refresh refs,
  expiry) — no provider.
- **Manually-added OAuth platforms** must carry a provider reference so refresh can source it.
  Catalog apps already declare `auth[].providerId`; ensure a manual OAuth platform stores its
  design reference on the platform row (add a field if missing).
- **Back-compat fallback (instrumented).** Existing OAuth credentials have `oauthMeta.providerId`.
  Keep reading it as a **fallback** during transition: source from platform first, fall back to the
  credential's stored providerId. **The fallback path MUST emit one structured log line when it
  fires** (`onOAuthProviderFallback` — the providerId + credentialId KIND/handle only, never a
  value) so the later drop is **evidence-based** (R6). A later cleanup increment drops the fallback
  + the column, gated on: 0012 shipped + fallback instrumented + **zero fallback hits observed**.

**Research §4 caveat — orphan OAuth credentials.** Phase 1 made `platformId` nullable, so an
*unlinked* OAuth credential has no platform to source from; the fallback is its **only** refresh
path until it is re-bound. Do NOT assume every OAuth credential has a platform. A test asserts the
fallback fires for an orphan OAuth credential (see §Tests).

## Delete the inert / dead surfaces (R2, R3) — do NOT build UI on dead data

Research proved these are dead — arctic ignores them or the path refuses them. Leaving them
dormant is the same lie one layer down (a future contributor will trust a field that does nothing).
Per junction's no-dead-code discipline (knip) they get **removed**, not hidden:

1. **Remove `tokenAuthMethod`** from `OAuthProvider` and all catalog entries. arctic always sends
   HTTP Basic when a client secret is present, ignoring this field. Document one line in
   `catalog.ts`: *"junction sends HTTP Basic client auth (arctic's fixed behavior); a provider that
   rejects Basic needs a hand-rolled token client — see revisit-when."*
2. **Remove `bodyFormat`** from `OAuthProvider` and all catalog entries. arctic always sends a
   form-encoded token request body. Same one-line doc note (form-encoded is fixed).
3. **Remove the `(cfg) => string` function form** from `authorizationUrl`/`tokenUrl` — narrow both
   to `string`. The refresh path already refuses fn-URLs (`oauth-refresh-fn.ts` `resolveTokenUrl`)
   and connect throws on them (`buildAuthorizeUrl`), so **nothing can depend on this branch**.
   Custom designs take **concrete string URLs only** (the user pastes their resolved per-tenant URL,
   e.g. `https://acme.okta.com/oauth2/v1/token`). This keeps designs fully serializable, refresh-safe,
   and the credential carrying zero provider knowledge.

   > No built-in catalog entry currently uses the fn-form, so this deletion is pure dead-code
   > removal, not a behavior change. Verify with a grep before deleting; if any entry uses it,
   > STOP and surface it (it would mean a live per-tenant provider that can't actually refresh —
   > a bug to file, not to paper over).

## Widen `pkce` (R5) — free correctness

- Widen `pkce: "S256" | "disabled"` → `"S256" | "plain" | "disabled"`. arctic already supports
  `CodeChallengeMethod.Plain`, so this is a one-word type change that unlocks the rare RFC-valid
  public client. Custom-design form defaults to `S256`.

## Global OAuth designs, made first-class (R1) — list + create + delete-unreferenced only

The management surface is deliberately **minimal** this increment — enough to satisfy "apps set up
providers directly, generic OAuth setups exist, credentials are provider-free," no more:

- **List** the built-in designs (`github`/`google`/`slack`/`generic`) as read-only records.
- **Create** a custom generic OAuth design (the field set below).
- **Delete** a custom design **iff it is unreferenced** by any platform (referential safety).
- **NO in-place edit this increment** (deferred — editing a referenced design's URLs raises live-token
  invalidation semantics that deserve their own thought; see revisit-when).

Apps/platforms reference a design by id (already the shape via `auth[].providerId`).

### Custom-design form field set (research §3)

**Must-ask (no safe default):**
- `displayName`
- `authorizationUrl` (concrete string)
- `tokenUrl` (concrete string)
- `scopes` / `defaultScopes` (free text, joined by `scopeSeparator`)
- `registrationHint.docsUrl` (+ **display** junction's fixed `OAUTH_CALLBACK_URI` for the user to
  register — shown, not asked)

**Advanced-only (sensible default, collapsed):**
- `scopeSeparator` — default `" "`
- `pkce` — default `"S256"` (now also offers `"plain"`)
- `supportsRefresh` — default `true`
- `expiryStrategy` — default `"expires_in"`
- `authorizationParams` (key/value) — default `{}` (Google `access_type=offline`, Atlassian `audience`)
- `deviceAuthorizationUrl` — default absent
- `userinfoUrl` + `userinfoHeaders` — default absent (absent = no Test Connection, honest, matches
  the current `generic` entry)
- `redirectMode` — default `"loopback-fixed"`

Client id/secret are entered at **connect** time per credential (BYO), NOT on the design — unchanged.
**Do NOT expose `tokenAuthMethod`/`bodyFormat` controls** — they were deleted above precisely because
a form control for an inert field lies (correctness-over-speed).

## Schema / migration

- Remove `providerId` from `credential.oauthMeta` **as a required linkage** (keep an optional legacy
  field read only by the instrumented fallback above; migrate off in the later cleanup increment,
  NOT here). Migration is data-touching → **data-migration reviewer required**.
- Add the manual-OAuth-platform provider-design reference field to the platform row (if missing).
- **Migration 0012** (drizzle-kit generated, never hand-authored): backfill the platform's
  provider-design field from the bound credential's old `providerId`. **Non-destructive** — the
  credential's `oauthMeta.providerId` is **kept** (never nulled in 0012); the column drop belongs to
  the cleanup increment only. **Orphan-credential-safe** — an unlinked OAuth credential has no
  platform row to backfill; the migration must not assume one exists.

### Data-migration reviewer flags (R6 — call these out explicitly)

1. **Orphan OAuth credentials** — nullable `platformId` (Phase 1) means some OAuth credentials have
   no platform; the fallback is their only refresh path. 0012 must not assume every OAuth credential
   has a platform.
2. **Ordering** — the platform provider field must be populated *before* any code path stops reading
   the credential's copy (same release minimum; same transaction better).
3. **Never destroy the source of a redirect-read in the migration that redirects it** — the
   `oauthMeta.providerId` column drop is the **cleanup increment's** job, not 0012's.

## Files

- **Edit** `packages/core/src/oauth/refresh.ts` (accept platform-sourced providerId + instrumented
  legacy fallback), `packages/source-runtime/src/resolve-provider.ts` (pass the platform's design to
  refresh), `packages/core/src/oauth/catalog.ts` (delete `tokenAuthMethod` + `bodyFormat` + the
  fn-URL form; widen `pkce`), `packages/core/src/schema/{credential,platform}.ts`,
  `packages/core/src/db/schema.ts` (+ migration 0012), `packages/core/src/apps/group.ts` (grouping
  sources provider from platform, not credential).
- **Edit/Add** web: the OAuth-designs surface (list built-ins + create custom + delete-if-unreferenced)
  + wire manual-OAuth-platform to a design reference.
- Tests: (below).

## Tests

- An existing OAuth credential still refreshes with `providerId` removed from the credential
  (sourced from platform).
- **The fallback fires for an orphan OAuth credential** (nullable platformId) and emits the
  instrumented log line.
- A custom generic design can be created (string URLs), listed, referenced by an app, and deleted
  only when unreferenced (delete-of-referenced is refused).
- `pkce: "plain"` is accepted by the schema + form.
- Grouping (`apps/group.ts`) still correct sourcing provider from the platform.
- Migration 0012: backfill populates the platform field; orphan credential is untouched and still
  refreshes via fallback; `oauthMeta.providerId` is preserved (non-destructive).

## Constraints

- **No in-flight OAuth credential may break** — the instrumented fallback guarantees refresh keeps
  working through the migration (including orphan credentials). This is the correctness bar
  (credential-security + data-migration reviewers both required, per `docs/behaviours`
  correctness-over-speed).
- Credentials end this phase **completely linkage-free** (no platformId reliance for identity, no
  providerId) — the user's requirement. Secrets-as-references unchanged.
- `docs/rules/`. Migration generated via drizzle-kit, never hand-authored.
- **Deleting inert fields is correctness work, not cleanup** — a form control (or catalog field)
  that silently does nothing violates correctness-over-speed.

## Deferred (record in `docs/futures/revisit-when.md` at step 9)

| Deferred | Trigger to revisit |
|---|---|
| Drop the `oauthMeta.providerId` fallback + column | 0012 shipped + instrumented fallback shows **zero hits** |
| OIDC discovery (`issuer`/`wellKnown`) — paste 1 URL, auto-resolve endpoints | Named **fast-follow (inc 45 candidate)**; the form is designed so an optional `issuer` field slots in without migration |
| In-place edit of OAuth designs | First real need to change a *referenced* design's URLs (decide live-token-invalidation semantics then) |
| Hand-rolled `client_secret_post` token client (bypassing arctic) | First provider whose token endpoint **rejects HTTP Basic** |
| Per-tenant connection-config on the platform binding | First **tuned** per-tenant catalog entry (Okta/Auth0/Microsoft/GitLab-self-hosted) |
| `tokenParams` (RFC 8707 `resource`/`audience` on the token request) | First provider requiring `resource`/`audience` on the token exchange (canonically Auth0 `audience` / Microsoft `resource`) |
| `client_credentials` / `private_key_jwt` / mTLS grants | YAGNI for single-user — no trigger scheduled |

## Proof-of-done

- A live OAuth credential (e.g. a Google/GitHub token) **still refreshes** with `providerId`
  removed from the credential — provider sourced from the platform. Proven against real refresh
  logic (test + real-server where a registered OAuth app is available; honest boundary noted where
  a live round-trip needs registered client creds).
- The instrumented fallback fires (and logs) for an orphan OAuth credential.
- A **generic/custom OAuth design** can be created globally (concrete string URLs), referenced by an
  app, and deleted only when unreferenced.
- `tokenAuthMethod`, `bodyFormat`, and the fn-URL form are **gone** from the schema (grep-clean);
  `pkce` accepts `"plain"`.
- Credentials carry no platform/provider linkage; the vault is fully independent.
- `pnpm verify` + knip + depcruise + dup green; migration + fallback tested.
