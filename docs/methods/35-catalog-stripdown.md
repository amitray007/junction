---
increment: 35
depends_on: []
soft_after: [33.1]
touches: [core, web]
parallel_group: A
---

# Increment 35 — Catalog strip-down to github-only

> **Source:** `docs/design/apps-ready-to-connect.md` §1a (positioning), §7 (decomposition).
> **User decision (2026-07-11):** "remove every other app, we will reintroduce
> them properly later." Removal is its own increment first; git history is the
> archive (no separate data archive); remove the orphaned OAuth providers too.

## What / why

junction's Apps catalog has ~54 apps, but only **github** is authored to the
depth the "ready to connect" design demands (its own `help.json` + hand-authored
tools). The other ~53 are thin stubs. Per the anti-Composio positioning
(§1a), **a thin catalog of deep apps beats a broad catalog of shallow ones** —
so we strip the catalog to **github only** and reintroduce each app *properly*
(deep, sovereign, fully-authored) in the following increments (36 GitHub
gold-standard → 37 Slack → 38 Gmail → 39 Google Calendar).

This is a **deletion increment**: no new feature code. Proof-of-done is a clean,
green tree with the catalog reduced to one app and no orphaned/dead code.

## Interfaces (unchanged)

No schema change, no API change. `getCatalogEntry` / `listCatalogEntries` /
`listApps` / `listProviders` keep their signatures; only their **data** shrinks.
A removed app id simply 404s at `/app/:id` (already the expected behavior).

## The removal + the fallout (from blast-radius recon)

### Catalog assembly = glob-based codegen (mechanical)

`packages/core/scripts/gen-catalog.mjs` `readdirSync`s the catalog dir and
iterates every subdirectory (no explicit import list). So the removal is:
**delete the app dirs → rebuild core → re-run the generator.** The generator
throws if **zero** dirs remain (`gen-catalog.mjs:82-86`) — keeping `github`
satisfies this.

`packages/web/scripts/gen-brand-icons.mjs` also globs the catalog (via
`core.listApps()`) and emits `brand-icons.generated.tsx` for only the used
iconSlugs — it must be regenerated too (shrinks to github's slug).

### Step-by-step

1. **Delete 53 app dirs.** Keep `packages/core/src/apps/catalog/github/`.
   Remove every other subdirectory under `packages/core/src/apps/catalog/`.
2. **Regenerate core catalog:** `pnpm --filter @junction/core build && pnpm
   --filter @junction/core gen:catalog` → rewrites `catalog.generated.ts` to
   github-only. **Do not hand-edit** the generated file. (The generator imports
   the schema from `dist/`, so the build MUST precede it.)
3. **Regenerate web brand icons:** `pnpm --filter @junction/web gen:brand-icons`
   (or the web build) → `brand-icons.generated.tsx` shrinks to github.
4. **Remove the 12 orphaned OAuth providers** from
   `packages/core/src/oauth/catalog.ts`: `google, slack, microsoft, notion,
   atlassian, discord, spotify, zoom, dropbox, linear, gitlab, figma`. Keep
   `github`, `github-app`, `generic`. Also delete now-dead
   `parseSlackTokenResponse` (`oauth/catalog.ts:100-129`) — nothing else
   references it once slack is gone (verify with grep; semgrep/knip would flag it
   otherwise).
   - **Rationale (user-approved):** an orphan provider is dead — no App links to
     it, so a connection with that providerId would mis-group to "Other", the
     exact inc-30 bug the coverage guard (`catalog.test.ts:107`) exists to
     prevent. Removing is honest; exempting leaves dead providers. **Slack and
     Google providers come back in inc 37/38**, re-added properly with their app.
5. **Fix the tests that break** (all under `packages/core` / `packages/web`):
   - `packages/core/src/apps/catalog.test.ts`:
     - `:19-36` seeded-apps `arrayContaining([...])` → reduce to `["github"]`.
     - `:51-64` notion/figma auth-mode tests → remove.
     - `:66-83` slack/spacex/hashnode absence tests → the spacex/hashnode
       negative controls still pass; the slack one is now vacuous — leave the
       genuine negative controls, drop the slack line.
     - `:107-120` the OAuth coverage guard → **passes as-is** once the orphan
       providers are removed (github/github-app covered, generic exempt). No
       edit needed beyond removing the providers.
     - `:134-217` the whole `32.6c surfaces backfill` describe block (gitlab/
       stripe/slack/notion/linear/sentry/vercel/openai/cloudflare/shopify) →
       delete the block (or reduce to a single github surface assertion).
   - `packages/core/src/apps/catalog.migration.test.ts` + `__fixtures__/pre-30.8-catalog.ts`:
     **delete both.** The fixture is a frozen ~48-id snapshot asserting
     `old ⊆ new`; every removed app breaks it. The 30.8 migration it guards is
     long-proven (4+ increments old). Deleting is the clean path — knip ignores
     `**/*.test.ts` and the fixture is imported only by that test.
   - `packages/core/src/apps/group.test.ts`: rewrite the cases that use removed
     apps as **live catalog apps** — `:126-133` (brave-search hyphen negative
     control), `:209-219` (filesystem public), `:250-251` (gitlab group),
     `:273-288` (google surface-less), `:290-298` (wpgraphql byo), `:300-309`
     (notion) → rewrite using `github` or synthetic/bogus ids (the
     `appIdForConnection` tests with bogus "totally-unrelated"/"ghost" ids are
     already fine and stay).
   - `packages/web/src/ui/brand-icon.test.tsx`: `:24,50,84,85` hard-assert
     `BRAND_ICONS.{gitlab,notion,slack,microsoft}?.category` (optional-chaining
     → silently `undefined` → `.toBe(...)` fails). Rewrite the color/mono/themed
     cases to use `github` (github is `themed`) or synthetic fixtures. The
     "themed github" case (`:35-47`) survives.
   - `packages/core/src/oauth/catalog.test.ts` (cascades from provider removal):
     - `:18-39` `listProviders includes all tuned providers` → reduce to
       `github/github-app/generic`.
     - `:42-74` inc-30 new-providers block → delete.
     - `:76-142` tuned-override cases for google/slack/microsoft/notion/atlassian
       → delete; keep github/github-app/generic.
     - `:144-153` `resolveScopeString` (slack+google) → rewrite with
       github+generic.
     - `:165-181` `buildAuthorizationParams` microsoft offline_access/defaultScopes
       → rewrite using a surviving provider (github has no defaultScopes; keep a
       synthetic provider inline or drop the dedupe-specific assertion).
     - `:184-216` `normalizeTokenResponse` slack `{ok:false}` parser → delete
       (parser is deleted).
     - `:252-281` userinfoUrl block (google/slack/microsoft/notion/atlassian) →
       reduce to github/github-app.

### Will NOT break (verified — do not touch)

`catalog-schema.test.ts` (inline github), `build-recipe.test.ts` (github only),
`surface-connections.test.ts`, `import-from-integrations*.test.ts` (pure
domain→slug, count assertions are about auth entries not app membership),
`app.index.tsx` (fully data-driven from `listApps()`), `app.$id.tsx` /
`data.functions.ts` (data-driven; removed id 404s), CLI `connect.test.ts` /
`credential.test.ts` / `pending-auth.server.test.ts` /
`-credentials.test.tsx` / `-platforms.test.tsx` (all use "google"/"slack"/etc.
as arbitrary mock strings, not catalog lookups). knip/depcruise unaffected
(catalog `*.json` not scanned; no per-app edges).

## Landmines

1. **Regenerate, don't hand-edit** the two `.generated.ts(x)` files. `gen:catalog`
   requires a prior `@junction/core build` (stale dist → wrong schema). The
   generator Biome-formats its own output.
2. **`brand-icon.test.tsx` reads are optional-chained** — a missing slug fails
   the assertion silently rather than crashing. Don't assume "no crash = pass."
3. **`parseSlackTokenResponse` becomes dead** with the slack provider — delete it
   or semgrep's bare-throw-exception comments / knip flag it.
4. **Docs carry stale coverage prose** (`STATE.md` "42 apps seeded"; the whole
   table in `docs/design/app-catalog-data.md`; `app.index.tsx:11` "45-card"
   comment). Non-blocking (not test-gated) but update `app-catalog-data.md` to
   note the strip-down and fix the `app.index.tsx` comment so it isn't fiction.
   `docs:check` validates the methods map, not the coverage prose.

## Proof-of-done

- `pnpm verify` green (build + typecheck + lint + test:ci + verify:web).
- `listApps()` returns exactly `[github]`; `listProviders()` returns exactly
  `[github, github-app, generic]`.
- No dead code (`parseSlackTokenResponse` gone; knip/semgrep clean).
- Orchestrator QA: drive the real built web server — `/app` grid shows only
  GitHub; `/app/slack` (etc.) 404s cleanly; `/app/github` still renders fully.
- Reviewers: junction-package-boundary + junction-clean-code +
  junction-credential-security (no credential/secret touched, but the OAuth
  provider table changed) — all clean.
- STATE.md + methods map updated; `app-catalog-data.md` annotated.

## Not in scope

Re-authoring any app (that's 36+). Touching the schema. Touching the sandbox,
audit, or serving paths.
