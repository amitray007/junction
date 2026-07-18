---
increment: 44
title: Phase 3 — OAuth designs first-class + credentials shed providerId
depends_on: [42, 43]
soft_after: []
touches: [core/oauth, core/schema, core/db, core/credentials, core/apps, source-runtime, web]
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
  design reference on the platform row (add a field if missing). **See the pre-build ruling below —
  the platform field is genuinely MISSING and this is a confirmed schema + migration change.**

## Pre-build Fable ruling (Findings 1–3) — code-verified delta, MUST fold into the build

A pre-build grounding pass against the CURRENT code found the plan under-specified in three ways;
a Fable product-owner ruled on each (the earlier dead-field/string-URL/pkce/instrumented-fallback/
no-edit/OIDC-deferred rulings all STAND — this only adds to them).

### R1 — the platform provider field is genuinely missing (schema + migration)

`PlatformSchema` has **no** provider field today; the provider is declared only on the app catalog
(`auth[].providerId`) and denormalized on the credential (`oauthMeta.providerId`). A manually-added
OAuth platform records its provider **only on the credential**. So:

- **Add `oauthProviderId?: string`** to `PlatformSchema` + the platforms table (a reference to a
  global OAuth design id; validated at use-time, NOT a Zod FK). Name matches the existing
  `conn.oauthProviderId` vocabulary in `group.ts`. Flat scalar, not a nested object — per-tenant
  concrete URLs live on the *design*, and per-tenant connection-config on the binding is already a
  named deferred item; a nested object here would prematurely duplicate that.
- **Migration 0012** backfills `platform.oauthProviderId` from each bound OAuth credential's
  `oauthMeta.providerId` (credential.platformId → platform row). **Non-destructive** (never touches
  the credential's copy), **fill-only-if-unset**, **idempotent**, **orphan-safe** (a credential with
  null platformId has no platform to backfill).
- **Conflict rule (deterministic):** if a platform's bound OAuth credentials *disagree* on
  providerId, 0012 leaves the platform field **unset** + emits one structured log; the instrumented
  fallback keeps both refreshing, a human resolves. Never guess, never overwrite an already-set value.
- **Dangling-reference rule (SECURITY — fail closed):** if `platform.oauthProviderId` points to a
  design that doesn't exist, refresh **fails closed with a typed error** — it does NOT fall back to
  the credential. The fallback fires ONLY when the platform has *no* provider source at all.
  Otherwise a misconfigured/maliciously-imported platform silently masks itself.

### R2 — vault archive carries providerId on BOTH entities + import-time backfill (load-bearing)

`export-vault.ts:249` writes `oauthMeta.providerId`; `import-vault.ts:696,1035` read it (both
optional-chained). The vault manifest embeds `PlatformSchema` verbatim (`vault-manifest.ts`), so the
new `platform.oauthProviderId` flows into the archive for free.

- Archived **platform** carries `oauthProviderId` automatically (manifest reuse — zero extra work).
- Archived **credential** KEEPS `oauthMeta.providerId` as **write-only-legacy** (identical treatment
  to `profileName` in Phase 1 — comment mirrors that style). It is the fallback's data source on
  re-import + old-junction import compat.
- **Import performs the 0012-equivalent backfill INLINE** (same fill-only-if-unset + conflict rule)
  when upserting/creating platforms. **This is load-bearing, not gold-plating:** without it, every
  old-format archive import permanently pins the fallback above zero → the cleanup increment's drop
  gate ("zero fallback hits") **can never fire** for a user who restored a vault → the transition
  silently never ends. Treat the import backfill as a SECOND migration surface (data-migration
  reviewer scrutinizes it as migration code).

### R3 — ONE shared resolver (refresh + grouping must not diverge)

Refresh and grouping diverging on which provider a credential belongs to is a **correctness bug**
(a connection grouped under one app but refreshed via another), not mere duplication — so this is a
"DRY the resolution primitive eagerly" case, not rule-of-three.

- **New `packages/core/src/oauth/resolve-provider-id.ts`** (name at builder discretion) —
  `resolveOAuthProviderId({ platform, appAuth, credential })`, fixed order:
  **platform.oauthProviderId → app catalog `auth[].providerId` → credential's legacy
  `oauthMeta.providerId` (instrumented fallback)**. Typed `Result`; dangling design reference =
  typed error (fail closed, per R1); the fallback log carries a **`context: "refresh" | "group"`**
  tag + ids only (never token material) so the drop gate's evidence is diagnosable.
- `oauth/refresh.ts` + `source-runtime/resolve-provider.ts` consume it.
- The connection-summary assembly that populates `conn.oauthProviderId` (feeding `group.ts`) consumes
  it; `group.ts:90`'s matching logic is unchanged (it's already provider-id-shaped).
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

## Global OAuth designs surface (R1) — READ-ONLY this increment; CREATE/DELETE → inc 45

> **SCOPE REVISION (Fable D5, mid-build ruling).** Custom-design **CREATE/DELETE is DEFERRED to inc
> 45**. inc 44 ships only the **read-only** designs surface + the platform→design wiring + the refresh
> re-source — which **fully satisfies the user's core requirement** ("credentials completely
> provider-free": the shipped core slice already removed the credential's authoritative provider —
> the platform's `oauthProviderId` + the fail-closed resolver own it now, legacy copy demoted to an
> instrumented fallback). Custom authoring was deferred because it needs a new persistence store
> (`oauth-designs.json`) + a signature change on the security-critical resolver, AND because **OIDC
> discovery IS the right authoring UX** (paste an issuer URL → junction fills the endpoints), so
> authoring + discovery belong together in inc 45. The existing `generic` escape hatch still covers
> bespoke providers meanwhile. Fable pre-ruled inc 45's design (persistence, resolver-as-data,
> `custom:<slug>` namespace, delete-if-unreferenced) — see `docs/futures/revisit-when.md`.

**This increment builds:**

- **List** the built-in designs (`github`/`google`/`slack`/`generic`) as **read-only** records
  (id, displayName, endpoints, pkce, supportsRefresh, registrationHint), each showing which platforms
  currently reference it.
- **Platform→design wiring UI:** platform setup/edit binds `oauthProviderId` from the built-in list;
  the binding validates the id resolves via `getProvider` (fail-closed at WRITE time, mirroring the
  resolver's read-time guard).
- **Refresh re-source surfaced:** platform detail shows the resolved design (and flags when resolution
  used the legacy fallback — feeding the drop-gate evidence).
- **The grouping re-source (R3) — CORRECTED SITE (Fable RB1).** The method file originally
  mislabeled `mutations.server.ts:237,367` + `cli/commands/credential.ts:244,556` as "grouping" —
  they are actually **verify-provider-hint** sites (they feed `verifyCredential`'s `oauthProviderId`,
  i.e. which design's `userinfoUrl` to bearer-probe for Test Connection), a DIFFERENT concern that
  the credential-security review already deferred to the column-drop increment. **The REAL grouping
  site is web-only, ONE place:** `packages/web/src/server/data.server.ts` — the `buildGroupInput`
  path (~line 483) that feeds core's pure `groupByApp`. Re-source THAT via `resolveOAuthProviderId`
  (the platform is already in scope there via `platformById`; `legacyProviderId = c.oauthState?.providerId`;
  a resolver error DEGRADES to "no hint" — omit `oauthProviderId`, never throw — grouping is
  display-only; fire `onProviderFallback` so grouping's fallback hits feed the SAME drop gate as
  refresh). Do NOT change `readCredentials`'s metadata shape. **No CLI work** (the CLI has no
  app-grouping surface). The 4 verify-hint sites + all other legacy readers stay OUT (deferred to
  the column-drop increment — see revisit-when).

**Deferred to inc 45 (do NOT build now):** the custom-design create form (field set below, kept for
inc 45's builder), the `oauth-designs.json` store, delete-if-unreferenced, the resolver-as-data
signature change, OIDC discovery.

### Custom-design form field set (research §3) — REFERENCE FOR INC 45, not built now

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
- **Add** `packages/core/src/oauth/resolve-provider-id.ts` — the shared `resolveOAuthProviderId`
  (R3); `packages/core/src/schema/platform.ts` gains `oauthProviderId?`.
- **Edit** `packages/core/src/credentials/{export-vault,import-vault}.ts` — export keeps
  `oauthMeta.providerId` write-only-legacy; import keeps both legacy reads AND performs the
  0012-equivalent inline backfill (R2).
- **Edit/Add** web: the OAuth-designs surface (list built-ins + create custom + delete-if-unreferenced)
  + wire manual-OAuth-platform to a design reference.
- Tests: (below).

## Tests

- An existing OAuth credential still refreshes with `providerId` removed from the credential
  (sourced from the platform via the shared resolver).
- **The fallback fires for an orphan OAuth credential** (nullable platformId) and emits the
  instrumented log line **with the `context` tag** (R3).
- **Dangling-reference fails closed** (R1): `platform.oauthProviderId` → a non-existent design →
  refresh returns a typed error, does NOT fall back to the credential.
- **0012 conflict rule** (R1): two credentials on one platform disagreeing on providerId → the
  platform field is left unset + a structured log; both still refresh via fallback.
- **Vault round-trip** (R2): an OLD-format archive (credential carries providerId, platform doesn't)
  imports → the platform GAINS `oauthProviderId` via the inline backfill → refresh works with the
  fallback NOT hit (proves the drop gate can converge).
- A custom generic design can be created (string URLs), listed, referenced by an app, and deleted
  only when unreferenced (delete-of-referenced is refused).
- `pkce: "plain"` is accepted by the schema + form.
- Grouping (`apps/group.ts`) still correct sourcing provider via the shared resolver.
- Migration 0012: backfill populates the platform field; orphan credential is untouched and still
  refreshes via fallback; `oauthMeta.providerId` is preserved (non-destructive); idempotent
  (re-running 0012 is a no-op).

## Constraints

- **No in-flight OAuth credential may break** — the instrumented fallback guarantees refresh keeps
  working through the migration (including orphan credentials). This is the correctness bar
  (credential-security + data-migration reviewers both required, per `docs/behaviours`
  correctness-over-speed).
- Credentials end this phase **completely linkage-free** (no platformId reliance for identity, no
  providerId) — the user's requirement. Secrets-as-references unchanged.
- `docs/rules/`. Migration 0012 is a **hand-authored** `.sql` (the DDL is trivial `ADD COLUMN`; the
  backfill logic — json_valid-guarded extract + conflict rule — is hand-written, same as 0011). The
  `json_extract` MUST be `json_valid`-guarded (a malformed `oauth_meta` otherwise throws and bricks
  the whole migration transaction — data-migration review, recorded in gotchas).
- **Deleting inert fields is correctness work, not cleanup** — a form control (or catalog field)
  that silently does nothing violates correctness-over-speed.

## Deferred (record in `docs/futures/revisit-when.md` at step 9)

| Deferred | Trigger to revisit |
|---|---|
| Drop the `oauthMeta.providerId` fallback + column | 0012 shipped + instrumented fallback shows **zero hits** (see the "Column-drop sweep checklist" in revisit-when — ALL 12 legacy readers must route through the resolver first) |
| **Custom-design CREATE/DELETE + `oauth-designs.json` store + resolver-as-data + `custom:<slug>` namespace + OIDC discovery** (Fable D5) | **inc 45** — deferred as one coherent unit (custom authoring needs a persistence store + a security-critical resolver signature change, and OIDC discovery IS the authoring UX). Fable pre-ruled the whole design (D1–D4 in revisit-when). |
| Route `verifyCredential` + the other 11 legacy readers through the resolver | the column-drop increment (do them all in one pass — piecemeal doesn't accelerate the drop) |
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
