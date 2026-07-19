---
increment: 45
title: Custom OAuth-design authoring + OIDC discovery + drop oauthMeta.providerId
depends_on: [44]
soft_after: []
touches: [core/oauth, core/persistence, core/credentials, core/db, source-runtime, cli, web]
parallel_group: A
---

# 45 — Custom OAuth-design authoring + OIDC discovery + drop `oauthMeta.providerId`

North star: `docs/specs/2026-07-17-credential-platform-normalization.md`. The follow-on to Phase 3
(inc 44). Makes the global OAuth designs **authorable** (create a custom generic design; OIDC
discovery fills endpoints from an issuer URL) and **completes the providerId normalization** by
re-sourcing the last legacy readers and dropping the `oauthMeta.providerId` column.

> **Design authority.** Scope + slicing below is the ruling of a Fable product-owner subagent
> (D1–D5 during inc 44, E1–E4 pre-build for inc 45). **Two rulings are load-bearing:**
> - **E2 — `profileName` is SPLIT to inc 46, NOT dropped here.** inc 42's "write-only legacy" note
>   was factually wrong: `profileName` is live-read in ~18 sites including the SOLE duplicate-account
>   guard. Dropping it is a credential-identity refactor deserving its own increment. inc 45 adds NO
>   new `profileName` readers and freezes vault label sourcing as-is.
> - **The user chose "both now"** (drop the columns, not authoring-only) — so the `oauthMeta.providerId`
>   drop IS in scope; only `profileName` moved to inc 46.

## Fable rulings this increment executes

- **D1 (persistence):** custom designs live in a dedicated versioned `oauth-designs.json`
  (`paths.oauthDesignsFile`, home-locked, atomic `writeFile0600`, Zod-versioned — the `tool-pins.ts`
  pattern). ONE deliberate difference from tool-pins: **fail-CLOSED on load error** (a corrupt
  designs file surfaces a typed error and does NOT silently serve a partial set into a refresh path)
  — because a design's `tokenUrl` is where refresh tokens are POSTed. (tool-pins fails *open*; designs
  must not.)
- **D2 (resolver visibility):** the resolver takes the merged design set as **DATA** — the caller
  loads custom designs at the I/O edge, merges with built-ins via a pure `mergeDesigns(custom)` in
  `catalog.ts`, and passes the merged lookup in. `getProvider`/`listProviders` stay **pure,
  built-ins-only**. A per-process cache is WRONG (junction is multi-process — CLI/web/`mcp serve`;
  a CLI-created design must be visible to a running web server → re-read the small file, refresh is
  rare). This changes the resolver signature (Slice A).
- **D3 (namespace):** custom ids are structurally `^custom:[a-z0-9][a-z0-9-]*$`, enforced by Zod at
  create AND at file-load; `mergeDesigns` additionally makes **built-ins always win** on any
  impossible collision. A custom design can NEVER shadow `github`/`google`/etc → no tokenUrl-redirect.
- **D4 (delete):** delete offered only for `custom:*` ids (built-ins undeletable — a delete request
  for one gets a typed rejection, not a 404); "unreferenced" = no platform's `oauthProviderId` AND no
  credential's legacy `oauthMeta.providerId` references it (the legacy arm dies with the column in
  Slice E, then this check simplifies); refuse with a typed error naming the referrers.
- **E1:** drop `oauthMeta.providerId` (Slice E, terminal).
- **E3/E4:** slice order + migration safety (below).

## Slice plan (integration order — `pnpm verify` after each; core slice A blocks)

Order: **A → (B ∥ C) → D → E.** The legacy fallback arm stays LIVE until Slice E, so no intermediate
commit can strand a refresh ("no in-flight OAuth credential breaks" holds at every integration point).

### Slice A (blocking core) — persistence store + resolver-as-data
- `paths.oauthDesignsFile` (`<home>/oauth-designs.json`).
- New `packages/core/src/oauth/designs-store.ts` — Zod-versioned schema (`{version, designs:
  Record<custom-id, CustomOAuthDesign>}`), load (fail-CLOSED typed error on corrupt/parse-fail),
  save (home-locked, atomic `writeFile0600`, re-read-under-lock-refuses-on-corruption like
  `tool-pins.ts`'s `savePinFile`). A `CustomOAuthDesign` is the authorable subset of `OAuthProvider`
  (id `custom:<slug>`, displayName, authorizationUrl, tokenUrl — concrete strings; scopeSeparator,
  pkce, supportsRefresh, defaultScopes, registrationHint, userinfoUrl?, expiryStrategy,
  authorizationParams?, redirectMode).
- `mergeDesigns(custom: CustomOAuthDesign[])` in `catalog.ts` — pure; returns a lookup where a
  `custom:` id resolves to the custom design and a built-in id ALWAYS wins over any collision.
- `resolveOAuthProviderId` gains the merged design set as a param (D2). **The legacy fallback arm
  stays intact this slice.** Its dangling-reference fail-closed guard now checks the MERGED set.
- Callers (refresh via `resolve-provider.ts`, the web grouping site) load custom designs + pass the
  merged set in.

### Slice B — OIDC discovery (feeds authoring)
- New `packages/core/src/oauth/oidc-discovery.ts` (or source-runtime if it needs HTTP — discovery
  fetches `<issuer>/.well-known/openid-configuration`; core is HTTP-free, so the FETCH lives in
  source-runtime, the parse/shape in core). Given an issuer URL, fetch the well-known doc, extract
  `authorization_endpoint`/`token_endpoint`/`userinfo_endpoint`/`scopes_supported`, return a
  partially-filled `CustomOAuthDesign` for the user to confirm. Validate at the boundary (Zod);
  fail typed on a non-conforming doc. SECURITY: only issuer URLs the user typed (never from observed
  content); the discovered tokenUrl becomes the design's tokenUrl (the exfil surface — the user
  confirms it before save).

### Slice C — re-source the ~12 `oauthMeta.providerId` readers (off the field, before the drop)
Re-source EACH through `resolveOAuthProviderId` (platform in hand) or remove the need:
- Verify-hints: `mutations.server.ts:237,367`, `cli/commands/credential.ts:244,556`.
- Display/reconnect: `cli/commands/credential.ts:443,829`, `cli/commands/connect.ts:71`,
  `web/server/oauth-connect.server.ts:226`.
- Vault: `export-vault.ts:257` (keep writing it to the archive for now — it's the recovery data +
  old-junction compat; the FIELD drop is Slice E, the ARCHIVE keeps carrying it),
  `import-vault.ts:493,763,1102` (the inline backfill + reads — keep reading the archive's copy).
- After Slice C, NOTHING in live refresh/verify/grouping/display reads `credential.oauthMeta.providerId`
  except the resolver's fallback arm (removed in E) and the vault archive I/O (which keeps it).

### Slice D — custom-design authoring ops + surfaces
- Core ops: `addCustomDesign` (validates `custom:<slug>`, no built-in collision, persists via the
  store), `listDesigns` (built-ins + custom, merged), `deleteCustomDesign` (D4: custom-only,
  refuse-if-referenced naming referrers).
- Web: extend the inc-44 read-only designs list in Settings with **Create** (form: displayName,
  authorizationUrl, tokenUrl, scopes + advanced-collapsed per the inc-44 field set; OR the OIDC
  "paste an issuer URL" front door that pre-fills via Slice B) + **Delete** (custom, unreferenced).
- CLI: `junction oauth-design add|list|rm` (scriptable/headless — every interactive path keeps a
  `--json` mode).
- Platform→design wiring: platform setup/edit can now bind a CUSTOM design id too (validated it
  resolves via the merged set).

### Post-C/D credential-security fix (folded in) — custom-design REFRESH works

The A+B+C credential-security review found a MEDIUM: the resolver resolved a `custom:<slug>` design
but `oauthRefreshFn` then did `getProvider(id)` (built-ins-only) → every custom-design refresh
dead-ended (fails closed, so security-safe, but functionally unusable). **Fixed:** `RefreshTokenFn`
now carries the ALREADY-RESOLVED `design` object (threaded from `refreshIfExpired` →
`performRefresh` → `callRefreshAndPersist` → `refreshFn`); `oauthRefreshFn` POSTs to
`design.tokenUrl` instead of re-looking-up. Regression test: a `custom:acme` design refreshes
through its own tokenUrl. (An id resolving to no design in the merged set → needs-reauth, never a
built-ins re-lookup.)

### Slice E (terminal, serial) — remove the fallback arm + drop the column
- Remove the legacy fallback arm from `resolveOAuthProviderId` (step 3) + delete `providerId` from
  `OAuthMetaSchema`/types. The resolver is now platform → app-catalog only.
- **Migration 0013 (E4 — verify-then-drop, fail closed):**
  - **Pre-drop verification pass (row-by-row, `json_valid`-guarded):** for every credential whose
    `oauth_meta` carries `providerId`, resolution MUST succeed via `platform.oauthProviderId` →
    app-catalog (the inc-44 path MINUS the fallback). Collect failures. **The drop executes ONLY if
    failures = 0**; otherwise the migration REFUSES (no drop) and prints a remediation list. Never
    silently strand a credential.
  - **Backfill arm:** where `platform.oauthProviderId` IS NULL, copy the credential's legacy value up
    (same conflict rule as 0012 — a platform with a DIFFERENT provider id is a conflict: list + abort,
    never overwrite — silently switching which OAuth app refreshes a token is a security bug).
  - **Recovery snapshot:** before the drop, persist `(credentialId → legacy providerId)` (a one-off
    table or the audit log). Data is destroyed with NO usage-window evidence — insurance is mandatory.
  - Then drop `providerId` from `oauth_meta` (table-rebuild or JSON-strip — whichever is
    non-destructive to the OTHER oauthMeta fields; do NOT touch `profileName`).
  - Inc-42/44 brick lessons: `json_valid` on every parse; row-by-row failure collection (NO single
    wrapping transaction where one bad row bricks + hides the rest); the drop atomic AFTER
    verification; forward-only; idempotent (already-dropped → no-op).
  - Vault compat: `import-vault` keeps accepting pre-45 archives (the archive still carries
    `oauthMeta.providerId` — ignore it, or use it for platform backfill). A fixture test imports a
    pre-45 archive and refreshes.

**Waves:** B ∥ C (disjoint touches). C before D (both touch `cli/credential.ts` + web; C is on E's
critical path). So A → (B ∥ C) → D → E, serial-integrated.

## Tests

- Designs store: round-trip; fail-CLOSED on corrupt file (typed error, NOT silent-empty); atomic
  write; re-read-under-lock refuses on corruption.
- `mergeDesigns`: a `custom:` id resolves; a custom id colliding with a built-in → **built-in wins**;
  `custom:<slug>` charset enforced at create AND load (a hand-edited `id:"github"` in the file is
  rejected at load).
- OIDC discovery: a well-known doc → a filled design; a non-conforming doc → typed error.
- Resolver: still fail-closed on a dangling reference in the MERGED set; the fallback arm removed in E.
- Slice C: each re-sourced reader gets its providerId from the resolver (assert, not the direct read).
- **Migration 0013 (adversarial):** verification passes → drop happens; a credential that can't
  resolve without the fallback → migration REFUSES (no drop) + remediation list; malformed
  `oauth_meta` (json_valid); OAuth credential with no platform; platform with a CONFLICTING provider
  id → abort; a `custom:<slug>`-referencing platform resolves; recovery snapshot written; idempotent
  re-run; empty DB.
- Vault: a pre-45 archive imports + refreshes (the dropped field's archive copy is tolerated).

## Constraints

- **No in-flight OAuth credential may break** — the fallback arm stays live until Slice E; the 0013
  migration verifies-then-drops, fail closed. **credential-security + data-migration reviewers both
  REQUIRED.**
- **Custom design `tokenUrl` is a token-exfiltration surface** — the user confirms it before save;
  a dangling/unknown design reference fails closed at refresh (unchanged from inc 44, now over the
  merged set); the store fails CLOSED on load corruption.
- **NO new `profileName` readers** (E2 — inc 46 drops it; don't deepen the coupling). Freeze vault
  `account` label sourcing as-is.
- Custom ids `^custom:[a-z0-9][a-z0-9-]*$` — built-ins always win, enforced at create + load.
- `docs/rules/`. Migration hand-authored, `json_valid`-guarded, forward-only, idempotent,
  row-by-row (no single-txn brick). Scriptable `--json` paths for every CLI command.

## Deferred

| Deferred | Trigger |
|---|---|
| **inc 46: drop `profileName`** (re-point the duplicate-account guard + refresh label + vault account onto `name`; restore a DB unique index) | inc 45 ships — do inc 46 immediately next (Fable E2) |
| In-place EDIT of a custom design | First need to change a *referenced* design's URLs (decide live-token-invalidation then) |
| `tokenParams` (RFC 8707 resource/audience) · `client_secret_post` hand-rolled client · per-tenant binding config | (unchanged from inc 44's deferred table) |

## Proof-of-done

- A **custom generic OAuth design** can be created (paste concrete URLs) OR via **OIDC discovery**
  (paste an issuer URL → endpoints filled), persisted to `oauth-designs.json`, listed alongside
  built-ins, referenced by a platform, and deleted only when unreferenced.
- A custom design CANNOT shadow a built-in id (rejected at create + load).
- A live OAuth credential still refreshes with `oauthMeta.providerId` DROPPED — sourced from the
  platform's design (proven against real refresh logic + the migration's verify-then-drop).
- The 0013 migration REFUSES (no drop) on a credential that can't resolve without the fallback, with
  a remediation list + a recovery snapshot.
- `pnpm verify` + knip + depcruise + dup green; both mandatory reviews clean.
