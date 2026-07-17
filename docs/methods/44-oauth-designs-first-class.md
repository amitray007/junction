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
- Back-compat: existing OAuth credentials have `oauthMeta.providerId`. Keep reading it as a
  **fallback** during a transition (source from platform first, fall back to the credential's
  stored providerId) so no in-flight OAuth credential breaks. A later cleanup drops the fallback.

## Global OAuth designs, made first-class

- Expose the existing `oauth/catalog.ts` `OAuthProvider` records (github/google/slack/**generic**)
  as a **manageable, global** layer — a `/settings` (or dedicated) view listing the designs, with
  the ability to add a **generic/custom** OAuth design (endpoints + scopes + registrationHint) the
  user's apps can then reference. "generic oauth or other global level oauths" (user's words).
- Apps/platforms reference a design by id (already the shape via `auth[].providerId`).

## Schema / migration

- Remove `providerId` from `credential.oauthMeta` **as a required linkage** (keep an optional
  legacy field read only by the fallback above, or migrate it off). Migration is data-touching →
  data-migration reviewer. Existing OAuth credentials must keep refreshing throughout.
- If a manual-OAuth-platform provider field is added, migrate existing manual OAuth platforms to
  populate it from their credential's old `providerId`.

## Files

- **Edit** `packages/core/src/oauth/refresh.ts` (accept platform-sourced providerId + legacy
  fallback), `packages/source-runtime/src/resolve-provider.ts` (pass the platform's design to
  refresh), `packages/core/src/schema/{credential,platform}.ts`, `packages/core/src/db/schema.ts`
  (+ migration 0012), `packages/core/src/apps/group.ts` (grouping sources provider from platform,
  not credential).
- **Edit/Add** web: the OAuth-designs management view + wire manual-OAuth-platform to a design.
- Tests: an existing OAuth credential still refreshes with `providerId` removed from the credential
  (sourced from platform); a custom generic design can be added and an app can use it; the legacy
  fallback path; grouping still correct.

## Constraints

- **No in-flight OAuth credential may break** — the fallback guarantees refresh keeps working
  through the migration. This is the correctness bar (credential-security + data-migration
  reviewers both required, per `docs/behaviours` correctness-over-speed).
- Credentials end this phase **completely linkage-free** (no platformId reliance for identity, no
  providerId) — the user's requirement. Secrets-as-references unchanged.
- `docs/rules/`. Migration generated via drizzle-kit, never hand-authored.

## Proof-of-done

- A live OAuth credential (e.g. a Google/GitHub token) **still refreshes** with `providerId`
  removed from the credential — provider sourced from the platform. Proven against real refresh
  logic (test + real-server where a registered OAuth app is available; honest boundary noted where
  a live round-trip needs registered client creds).
- A **generic/custom OAuth design** can be created globally and referenced by an app.
- Credentials carry no platform/provider linkage; the vault is fully independent.
- `pnpm verify` + knip + depcruise + dup green; migration + fallback tested.
