---
increment: 30
title: App — first-class "connect a service" concept (derive-grouping, G-minus)
depends_on: [29]              # builds on the shipped OAuth connect/refresh + credential model
soft_after: []
touches: [core, web, cli]     # core (AppCatalog + groupByApp) · web (Apps surface) · cli (optional read cmd)
parallel_group: A             # core slice blocks; web ∥ cli leaves fan out after it
---

# Increment 30 — App: first-class "connect a service" concept

> **Design source of truth:** `docs/design/provider-concept.md` (approved with the user
> 2026-07-04, adversarially reviewed). This method file is that design's executable slice.
> Read the design doc first — this file assumes its decisions and does not re-argue them.

## 0. TL;DR for the builder

Add a new top-level **App** concept to junction's web dashboard — a "connect a service"
surface where the user browses supported apps (GitHub, Google, …), opens `/app/:id`, and sees
**their connections to that app** (each = one account + the one way it's connected + live
status + a lifecycle menu). This is a **re-presentation over existing data** — the app
grouping is **derived live** (NO new DB table, NO migration, NO schema change). The dogfooded
inc-29 OAuth connect/refresh path is reused unchanged.

**Hard invariants (do not violate):**
- **NO schema change / NO migration.** The grouping is computed, not persisted.
- **`core` stays HTTP-free** (`AppCatalog` + `groupByApp` are pure data + a pure function).
- **Credentials stay refs-not-values / metadata-only at the web edge** (reuse the existing
  `CredentialMeta` / `readCredentials` DTO discipline — never a secret/secretRef).
- **Reuse inc-29's connect/reconnect/test/rotate/rename/remove ops** — do not reinvent them.
- **Do NOT name anything `Provider`** — that word is reserved (OAuth catalog + `ToolProvider`).
  The new concept is **`App`** in code (`AppCatalog`, `AppId`, `/app/:id`).
- Every change QA-able: `pnpm verify` green + a behaviour test + drive the real running server.

---

## 1. What & why (mini-spec)

### The problem
junction has three axes; two are modelled, one is missing:
- **Platform kind** (`mcp/openapi/graphql/cli`) = the protocol junction speaks — modelled.
- **Credential kind** (`oauth2/bearer/api-key/env/file`) = how you authenticate — modelled.
- **App** (github/google/slack/…) = which real-world service this all belongs to — **absent.**

Today "my GitHub" has no home: its MCP platform, its REST platform, and its OAuth credential
are disconnected rows with nothing tying them together. Inc 30 adds the App axis as a
**derived, read-layer** concept + a new front-door surface.

### The shape (from the design doc — decided)
- **App = a catalog entry** (new pure data in `core`) describing a real service:
  `{ id, displayName, supportedKinds, auth, setupHints }`. `supportedKinds` = *which
  `Platform.kind`s junction can stand up for this app* (junction's CAPABILITY, not the
  vendor's API surface — stays true by construction).
- **Grouping is derived live** (`groupByApp`): map existing platforms+credentials onto their
  App. Prefer the **authoritative** `oauthMeta.providerId` (written by the inc-29 connect
  flow) over heuristic platform-id matching; bucket the unmatched honestly as "Other".
- **The per-app page is a list of connections**, not a dense grid — honoring "choose once"
  (a vertical is a choice made at connect time, not a checklist) while keeping the
  **multi-account wedge** (accounts multiply: work + personal).
- **Lifecycle menu** per connection surfaces **shipped inc-24–29 ops only** (test / reconnect
  / rotate / rename / disconnect + "+ Connect account"). **"Change method" is DEFERRED to
  inc 30.5** (§8) — the one genuinely new, non-atomic op; not built here.
- **IA:** new **Apps** sidebar item (primary); Platforms/Credentials/Profiles kept reachable,
  separated by the existing bare hairline (**no eyebrow label** — inc-24.5 rule honored).
  junction's transparency differentiator is preserved, not hidden.

### Proof of done
- `pnpm verify` green (build + typecheck + Biome + Vitest), self-contained.
- The web dashboard shows an **Apps** nav item; `/app` lists supported apps with a
  connected/available indicator.
- `/app/github` (against `/tmp/jt29ui`) lists the user's real GitHub connections with correct
  status badges and a working lifecycle menu.
- `/app/google` (against `/tmp/jt29ui`) lists the user's real Google connections with correct
  status badges (a distinct check — guards against a shipped OAuth provider mis-grouping to
  "Other", the bug real-server QA caught).
- The inc-29 OAuth connect + refresh + badges are **byte-identical** after the change (driven
  against the real running server, `docs/behaviours/verify-the-artifact.md`).
- **Grouping tests (positive AND negative controls — review C2):** a GitHub platform + a GitHub
  oauth credential (`oauthProviderId:"github"`) groups under "github"; a **bearer**-authed
  GitHub platform whose id exactly matches groups under "github" via the id heuristic; a
  bearer GitHub whose id does NOT match lands in **"other"** (assert it — don't pretend it
  groups); the **wedge** (two accounts on one platform) yields two connections; a
  public/no-credential platform yields a credential-less connection.
- **`readApps` metadata-only test** (no secret/secretRef in the DTO) + **`getApps` host-guard
  test** — parity with every existing server module.
- **Catalog-integrity test:** every app's `auth[]` `oauth2` `providerId` resolves via
  `getProvider()` (a typo would dead-link the connect CTA).
- **Reverse-coverage test:** every non-generic OAuth provider in `listProviders()` has a
  matching App entry (else a real OAuth connection mis-groups to "Other" — the green-but-blind
  bug caught in real-server QA; see `docs/futures/gotchas.md`).

---

## 2. Interfaces (the contracts this increment introduces)

### 2a. `core` — the App catalog (pure data) + the grouping function

New module `packages/core/src/apps/catalog.ts` (mirrors `oauth/catalog.ts`'s pure,
divergence-as-data style):

```ts
export type AppAuth =
  | { mode: "oauth2"; providerId: string }   // → links to an oauth/catalog.ts entry by id
  | { mode: "token" }                          // bearer / api-key (paste a token)
  | { mode: "byo" }                            // generic escape hatch (user supplies details)

export interface AppDefinition {
  id: string                    // "github" | "google" | … (App id; NOT a Platform.id)
  displayName: string
  /** Which Platform.kinds junction can STAND UP for this app (capability, not vendor surface). */
  supportedKinds: PlatformKind[]
  /** How you authenticate to this app (may be several ways; first = default). */
  auth: AppAuth[]
  /** Short guided-setup hints shown on the /app/:id empty state. */
  setupHints?: string[]
}

export function getApp(id: string): AppDefinition | undefined
export function listApps(): AppDefinition[]
```

New pure grouping function `packages/core/src/apps/group.ts`.

**Attribution is grained at the CONNECTION level, not the platform level** (review C2). A
"connection" = one credential + its platform (the account + the chosen vertical). Grouping
per-connection sidesteps the "which app owns a platform that has two different-provider
credentials" ambiguity entirely — each connection attributes independently, which also matches
the per-app page's list-of-connections model (§7). A public/no-credential platform contributes
a **credential-less connection** (account = "—") attributed by the platform heuristic alone.

```ts
/** One connection = one account's access to an app via one vertical. */
export interface Connection {
  appId: string                 // resolved app id, or "other"
  account: string               // credential profileName, or "—" for a public platform
  platformId: string
  kind: PlatformKind            // the chosen vertical
  // status fields carried through from CredentialMeta (verify result, oauthState) — metadata only
}

/**
 * Resolve ONE connection's app id. Attribution order (NO fuzzy/substring matching — that rots):
 *   1. authoritative: the credential's oauthProviderId (from oauthMeta.providerId) if present
 *      → map providerId → appId (an app whose auth[] contains {mode:"oauth2", providerId}).
 *   2. exact, case-insensitive match of platform.id against AppDefinition.id.
 *   3. exact, case-insensitive match of platform.id against AppDefinition.aliases[] (see below).
 *   4. exact, case-insensitive match of platform.displayName against id/displayName.
 *   5. else → "other".
 */
export function appIdForConnection(
  conn: { platformId: string; platformDisplayName: string; kind: PlatformKind; oauthProviderId?: string },
  platformIndex: /* id/displayName lookups */,
): string   // never undefined — unmatched returns "other"

/**
 * Group platforms + credentials into apps. PURE — no I/O. The web/cli read layers feed it
 * their already-loaded metadata lists. Every connection lands in exactly one group (an app
 * from the catalog, or the synthetic "other" group). An app in the catalog with zero
 * connections is NOT emitted here — the /app INDEX left-joins listApps() against these groups
 * (§2b) so unconnected apps still appear as browsable cards.
 */
export function groupByApp(input: {
  platforms: { id: string; kind: PlatformKind; displayName: string }[]
  credentials: { platformId: string; account: string; oauthProviderId?: string; /* status */ }[]
}): AppGroup[]
```

`AppGroup` = `{ appId, connections: Connection[] }`. **`AppDefinition` gains an optional
`aliases?: string[]`** so a service reachable under a couple of well-known platform-ids
(e.g. github ← "gh", "github-rest") attributes correctly WITHOUT fuzzy matching. The "other"
group has no `AppDefinition` (see §2b for how the index/route handle it).

**DTO mapping the web edge MUST do (review C2):** `CredentialMeta` nests the provider id as
`oauthState.providerId` — there is NO flat `oauthProviderId` field. `readApps` maps
`credential.oauthState?.providerId → oauthProviderId` before calling `groupByApp`. Skipping
this silently buckets every OAuth connection into "other" (the exact green-but-blind failure
the positive-control test guards).

> **Why pure, in `core`:** everything imports `core`; the catalog is knowledge, the grouping
> is a pure transform. No HTTP, no repos here — the web/cli edges load the rows and call these.
> Keeps `core-not-http` + the boundary rules satisfied. Export from `core`'s barrel
> (`packages/core/src/index.ts`), same as `oauth/catalog.ts`.

### 2b. `web` — the Apps surface

- New server-fn `getApps` in `data.functions.ts` → `readApps` in `data.server.ts`: loads
  `readPlatforms()` + `readCredentials()` (already metadata-only), calls `groupByApp`, returns
  an `AppGroupMeta[]` DTO (metadata-only — reuses `CredentialMeta`'s oauth state; NEVER a
  secret/ref). Host-guarded like every other server-fn.
- New routes:
  - `packages/web/src/routes/apps.tsx` → `/app` index: **renders `listApps()` as the spine**,
    left-joining connection counts from `groupByApp` (available = in catalog; connected = ≥1
    connection). **Plus a synthetic "Other" card** when any connection attributes to "other"
    (transparency — nothing hidden, §8), routing to a guarded `/app/other`.
  - `packages/web/src/routes/app.$id.tsx` → `/app/:id`: the per-app page. `getApp(id)` for a
    catalog app; for `id === "other"` render a synthetic group (fixed "Other / uncatalogued"
    label — do NOT call `getApp("other")`, it returns undefined). Empty-state catalog CTA when
    no connections; list-of-connections + lifecycle ⋯ menu when populated. An unknown id
    (not in catalog, not "other", no connections) → not-found.
- Sidebar: add `{ to: "/app", label: "Apps", icon: <a Lucide icon, e.g. Boxes/Grid/LayoutGrid> }`
  to `NAV_TOP` at position 2 → order `Dashboard, Apps, Audit, API Keys, Settings`. Platforms/
  Profiles/Credentials stay in `NAV_DATA`, separated by the **existing bare hairline
  separator — NO "Advanced" eyebrow label** (honor the inc-24.5 no-eyebrow rule; user decision
  2026-07-04). `/app` active-highlight uses the existing `startsWith` logic (stays active on
  `/app/:id`); do NOT add a separate detail nav item.
- The lifecycle ⋯ menu reuses the EXISTING mutation server-fns (from `mutations.functions.ts`
  + `oauth-connect.functions.ts`) — surfacing shipped ops only: `testCredentialFn`,
  `startReconnectFn`, `rotateCredentialFn`, `renameCredentialFn`, `removeCredentialFn`, and
  `startConnectFn` (for "+ Connect account"). **"Change method" is DEFERRED to inc 30.5**
  (user decision 2026-07-04 — see §8) — it is NOT an atomic op and needs an additive
  reconnect-first ordering + a client-cred-reuse helper + a security pass; do NOT build it here.

### 2c. `cli` (optional leaf) — a scriptable read

`junction app list` / `junction app show <id>` — the headless path (every interactive surface
keeps a `--json` path, `docs/rules`). Reads `listApps()` + repos, calls `groupByApp`, prints.
**May be deferred to a fast-follow** if inc 30 gets large — decide at build time; not blocking.

---

## 3. Implementation plan (slices)

**Wave shape (mode A):** one blocking **core slice**, then **web ∥ cli** leaves. Small
increment — if it reads cleaner as one serial build, that's fine (waves are a default, not a
mandate). Recommended: core first (committed-to-lock), then web (the substantive slice), cli
optional.

### Slice A (core, blocking) — `AppCatalog` + `groupByApp`
1. `packages/core/src/apps/catalog.ts` — `AppDefinition` (+ optional `aliases`), `getApp`,
   `listApps`. **Seed from the researched real-service data** (`docs/design/app-catalog-data.md`
   — the orchestrator's research output, ≥10 verified real services PER category across oauth /
   mcp / openapi / graphql / cli). Each entry: `supportedKinds` = *what junction can stand up
   today*, `auth[]` linking oauth2 entries to the matching `oauth/catalog.ts` provider id.
   **Include non-OAuth apps** (token/BYO) so the catalog proves App ⊥ auth-mechanism (design
   §6). Only ship VERIFIED connection data — no invented package names / spec URLs / endpoints.
2. `packages/core/src/apps/group.ts` — `appIdForConnection`, `groupByApp` (pure).
   **Connection-level attribution** (§2a): authoritative `oauthProviderId` → then EXACT
   case-insensitive id → `aliases` → displayName; else "other". NO fuzzy/substring matching.
3. Barrel exports in `packages/core/src/index.ts`.
4. **Tests** (`apps/catalog.test.ts`, `apps/group.test.ts`): catalog lookups; **catalog
   integrity** (every oauth2 `providerId` resolves via `getProvider`); and grouping
   **positive + negative controls** — GitHub-oauth groups under "github"; bearer-GitHub with
   matching id groups; bearer-GitHub with NON-matching id lands in "other" (asserted); the
   wedge → two connections; a public/no-credential platform → a credential-less connection.
5. `pnpm verify` green. Commit-to-lock before any leaf fan-out (STATE §3 orchestration rule).

### Slice B (web, leaf) — the Apps surface
6. `readApps` (`data.server.ts`) + `getApps` (`data.functions.ts`) — `AppGroupMeta[]` DTO,
   metadata-only, host-guarded. Reuse `readPlatforms`/`readCredentials`; **map
   `oauthState?.providerId → oauthProviderId`** before calling `groupByApp` (review C2).
7. `/app` index route (`apps.tsx`) — **`listApps()` as the spine**, left-joined with the
   groups for connected/available; **synthetic "Other" card** when any "other" connections
   exist.
8. `/app/:id` route (`app.$id.tsx`) — empty-state catalog CTA + list-of-connections + the
   lifecycle ⋯ menu (wired to EXISTING mutation fns — **no "Change method"**, deferred to 30.5).
   `id === "other"` renders the synthetic group (fixed label, do NOT `getApp("other")`).
9. Sidebar: add **Apps** to `NAV_TOP` at position 2 (`Dashboard, Apps, Audit, API Keys,
   Settings`); keep Platforms/Profiles/Credentials in `NAV_DATA` behind the **existing bare
   hairline separator — no eyebrow label**.
10. **Tests:** component tests (happy-dom/Testing-Library) for both routes (empty→CTA,
    populated→connections+badges, ⋯ menu exposes the shipped lifecycle actions); the `readApps`
    **metadata-only** assertion (JSON-stringify negative test, like `data.server.test.ts`); the
    `getApps` **host-guard** test. Follow inc-24+ web patterns.
11. Clean stale `.js` in `src/routes/` before `vite build` (inc-24.5 gotcha).

### Slice C (cli, optional leaf) — `junction app`
12. `junction app list` / `show <id>` (+ `--json`). Reads catalog + repos + `groupByApp`.
    Child-process integration test like the other CLI commands. **Defer if inc 30 is large.**

### Integration + QA
13. Serial integration in the one tree, `pnpm verify` after each slice.
14. Drive the **real running server** against `/tmp/jt29ui`
    (`JUNCTION_HOME=/tmp/jt29ui PORT=4321 node packages/web/serve.mjs`):
    - `/app` lists apps; GitHub + Google show "connected".
    - `/app/github` lists the real connection(s) with correct status; the ⋯ menu works.
    - The existing Credentials/Platforms/Profiles pages still work (now under "Advanced").
    - **Regression:** re-run an inc-29 OAuth connect + a refresh; badges byte-identical.
    - Secret adversarially absent from DOM/HAR/SSR-HTML/log (reuse `junction-web-verify`).

---

## 4. Reviewers (per-slice, parallel)

- **Always:** `junction-package-boundary` (core-not-http, dependency direction, no cross-app
  import), `junction-clean-code-reviewer` (typed errors, single-purpose, validation).
- **Slice A (core):** `ce-correctness-reviewer` (the grouping attribution logic + "other"
  bucket + wedge cardinality), `ce-maintainability-reviewer` (catalog stays curated-small).
- **Slice B (web):** `junction-web-reviewer` (server-only-core boundary, credentials
  metadata-only, design-token discipline, a11y, component tests), `ce-correctness-reviewer`
  (the index left-join + the "other" routing + active-nav behaviour).
- **Security lens:** confirm the new read surface leaks no secret/ref (metadata-only DTO).
  Reuse the `web:leakcheck` gate on the built bundle.
- Run CodeRabbit CLI before merge (repo helper); resolve AND reply to every thread
  (GraphQL `resolveReviewThread` — the merge-block gotcha, STATE §3 / gotchas.md).

## 5. Do-NOT list
- Do NOT add a `platforms.app` column or any migration (that's graduation option G, deferred).
- Do NOT create an owning App entity/table (option E, deferred — trigger in revisit-when.md).
- Do NOT touch `OAuthMetaSchema`, `persistOAuthTokens`, or the refresh engine.
- Do NOT name anything `Provider` in code.
- Do NOT hide/remove the Platforms/Credentials/Profiles pages — bare-separator only, no label,
  stay fully functional.
- Do NOT build "Change method" (deferred to inc 30.5, §8).
- Do NOT fuzzy/substring-match in attribution — exact case-insensitive only, else "other".
- Do NOT ship invented catalog data — only VERIFIED real connection details (§8 research).
- Do NOT return raw core types at the web edge — metadata-only DTOs.

## 6. Report-back (what the builder returns)
- Files created/changed; `pnpm verify` result (paste tail); the grouping positive+negative
  control test output; confirmation the inc-29 flow is unchanged (byte-identical badges); which
  connections landed in "other" and why; whether the cli slice shipped or deferred.

---

## 7. Forward register (record at ship — `docs/futures/`)
- **`revisit-when.md`:** graduation triggers — **G (validated `platforms.app` column):** a
  write-time app override the derivation can't express (e.g. a user manually re-attributing a
  platform). **E (owning App entity):** >1 client config per app, or BYO-client reuse the user
  wants to manage as one owned object, or user-authored app definitions.
- **`gotchas.md`:** if the grouping heuristic surprises (mis-groups / over-buckets to "other"),
  record the symptom + that the authoritative `oauthProviderId` is the reliable key.
- Update `docs/methods/README.md` (mark inc 30 `done`), `docs/STATE.md` (§1 snapshot + §7 log
  + the `STATE-done-through` marker), via the `junction-handover` skill.

---

## 8. Deferred to inc 30.5 (its own follow-up increment — user decision 2026-07-04)

inc 30 ships the App **surface**; the richer, higher-risk lifecycle lands in **inc 30.5**,
which collects everything deliberately held back from 30 so 30 stays low-risk and additive:

- **"Change method"** — swap a connection's vertical (e.g. REST → MCP). NOT atomic: a REST and
  an MCP connection are different `Platform` rows + `Credential`. Must be an **additive,
  reconnect-first** flow: create the new-kind platform + connect the new credential + verify
  the callback `ok` **first**, and only **then** remove the old credential + platform — so a
  failed/abandoned reconnect leaves the original connection intact (no stranding). Requires a
  **new named helper** to reuse the old credential's stored client creds cross-vertical
  (`startConnect` today REQUIRES client creds and has NO reuse path — the reuse only exists in
  `startReconnect`; PR #94's reuse does NOT apply to `startConnect`). Needs a dedicated
  **security-reviewer pass** (credential-store touch; must not strand or leak client creds).
- **Test Connection should auto-refresh before testing (OAuth) — BUG.** A Google credential
  connected yesterday shows "Auth Failed" on Test Connection because it verifies the CURRENT
  (expired) access token without refreshing first — yet the credential is valid (it
  auto-refreshes when actually used via MCP). Fix: for an OAuth credential with a refresh
  token, Test Connection must `refreshIfExpired` (or force a refresh) FIRST, then verify — so a
  refreshable credential reports Connected, not Auth Failed. Affects BOTH the Credentials page
  test and the new Apps per-connection Test (shared verify path — inc-29 refresh engine
  `shouldRefresh`/`refreshIfExpired` + single-flight). Verify against `/tmp/jt29ui` (real
  Google, expired access token + valid refresh token → Test refreshes + passes).
- **Per-app icons/logos in the Apps surface — ENHANCEMENT.** Add a per-app glyph to the catalog
  cards + per-app header so the surface is scannable. Needs a research pass on the SVG source:
  MUST be self-contained (no runtime CDN — web CSP + AGPL self-host), theme-aware, license OK
  for AGPL redistribution. Candidates: **simple-icons** (large brand-icon npm set, offline
  SVGs — likely the strongest fit), `@thesvg/cli` (user suggestion, build-time fetch); lucide
  (already used but generic, not brand). Add an optional `iconId`/slug to `AppDefinition`;
  render inline SVG with a first-letter-tile fallback for apps without one.
- Any other lifecycle richness surfaced during the inc-30 build that isn't a straight reuse of
  a shipped op.

Add inc 30.5 to `docs/methods/README.md` as `planned` when inc 30 merges (audit stays 31).
