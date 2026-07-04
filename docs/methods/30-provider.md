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
- **Lifecycle menu** per connection surfaces shipped inc-24–29 ops + one NEW op ("Change
  method" = guided disconnect+reconnect via a different vertical — a compose of shipped ops,
  NOT an atomic in-place mutation).
- **IA:** new **Apps** sidebar item (primary); Platforms/Credentials/Profiles kept reachable
  under an "Advanced" group (junction's transparency differentiator is preserved, not hidden).

### Proof of done
- `pnpm verify` green (build + typecheck + Biome + Vitest), self-contained.
- The web dashboard shows an **Apps** nav item; `/app` lists supported apps with a
  connected/available indicator; `/app/github` (against `/tmp/jt29ui`) lists the user's real
  GitHub + Google connections with correct status badges and a working lifecycle menu.
- The inc-29 OAuth connect + refresh + badges are **byte-identical** after the change (driven
  against the real running server, `docs/behaviours/verify-the-artifact.md`).
- A **positive-control test** on `groupByApp` proves a known GitHub platform+credential lands
  under the GitHub App (guards the new "green but blind" grouping surface — STATE §3).

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

New pure grouping function `packages/core/src/apps/group.ts`:

```ts
/** A platform's App id, or undefined if it can't be attributed. */
export function appIdForPlatform(
  platform: { id: string; kind: PlatformKind },
  // the OAuth credential(s) on this platform carry the authoritative providerId
  credentials: { platformId: string; oauthProviderId?: string }[],
): string | undefined

/**
 * Group platforms + credentials into apps. PURE — no I/O. The web/cli read layers
 * feed it their already-loaded lists. Unmatched platforms bucket under "other".
 */
export function groupByApp(input: {
  platforms: { id: string; kind: PlatformKind; displayName: string }[]
  credentials: { platformId: string; account: string; oauthProviderId?: string; /* status fields */ }[]
}): AppGroup[]
```

`AppGroup` shape (what the per-app page renders): the App definition + the list of
**connections** under it (each = `{ account, platformId, kind (the chosen vertical), status }`).
Attribution rule: **prefer `oauthProviderId`** (authoritative, from `oauthMeta.providerId`);
fall back to matching `platform.id`/`displayName` against `listApps()`; else "other".

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
  - `packages/web/src/routes/apps.tsx` → `/app` index: browse `listApps()` with a
    connected/available indicator per app (derived from the groups).
  - `packages/web/src/routes/app.$id.tsx` → `/app/:id`: the per-app page (empty-state catalog
    CTA when no connections; list-of-connections + lifecycle ⋯ menu when populated).
- Sidebar: add `{ to: "/app", label: "Apps", icon: <choose a Lucide icon, e.g. Boxes/Grid> }`
  to `NAV_TOP` (primary), and move Platforms/Profiles/Credentials under an **"Advanced"**
  group eyebrow (they already sit in `NAV_DATA` — add the group label + visual separation).
- The lifecycle ⋯ menu reuses the EXISTING mutation server-fns (from `mutations.functions.ts`
  + `oauth-connect.functions.ts`): `testCredentialFn`, `startReconnectFn`, `rotateCredentialFn`,
  `renameCredentialFn`, `removeCredentialFn`, `startConnectFn`. **"Change method"** is a guided
  flow that composes `removeCredentialFn` (+ platform delete) then `startConnectFn` against a
  different `Platform.kind`, reusing stored client creds (inc-29 PR #94 reconnect-reuse).

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
1. `packages/core/src/apps/catalog.ts` — `AppDefinition`, `getApp`, `listApps`. Seed the
   **OAuth-8 + generic** apps (github, github-app, google, slack, microsoft, notion,
   atlassian, generic), each with `supportedKinds` = *what junction can stand up today* and
   `auth` linking to the matching `oauth/catalog.ts` provider id. Keep it small and honest.
2. `packages/core/src/apps/group.ts` — `appIdForPlatform`, `groupByApp` (pure). Attribution
   prefers `oauthProviderId`; falls back to id/displayName match; else "other".
3. Barrel exports in `packages/core/src/index.ts`.
4. **Tests** (`apps/catalog.test.ts`, `apps/group.test.ts`): catalog lookups; and the
   **positive-control** grouping test — a GitHub platform + a GitHub oauth credential (with
   `oauthProviderId: "github"`) groups under the "github" App; an unattributable platform
   lands in "other"; the wedge (two accounts on one platform) yields two connections.
5. `pnpm verify` green. Commit-to-lock before any leaf fan-out (STATE §3 orchestration rule).

### Slice B (web, leaf) — the Apps surface
6. `readApps` (`data.server.ts`) + `getApps` (`data.functions.ts`) — `AppGroupMeta[]` DTO,
   metadata-only, host-guarded. Reuse `readPlatforms`/`readCredentials`.
7. `/app` index route (`apps.tsx`) — browse apps, connected/available indicator.
8. `/app/:id` route (`app.$id.tsx`) — empty-state catalog CTA + list-of-connections + the
   lifecycle ⋯ menu (wired to existing mutation fns). "Change method" guided flow.
9. Sidebar: add **Apps** to `NAV_TOP`; group Platforms/Profiles/Credentials under "Advanced".
10. **Component tests** (happy-dom/Testing-Library) for the two routes: empty state renders
    the CTA; populated state lists connections with correct badges; the ⋯ menu exposes the
    lifecycle actions. Follow the inc-24+ web write-path test patterns.
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
  (the "Change method" compose-of-ops flow — the one genuinely new behaviour).
- **Security lens:** confirm the new read surface leaks no secret/ref (metadata-only DTO) and
  that "Change method" can't strand a credential or leak client creds during the
  disconnect+reconnect. Reuse the `web:leakcheck` gate on the built bundle.
- Run CodeRabbit CLI before merge (repo helper); resolve AND reply to every thread
  (GraphQL `resolveReviewThread` — the merge-block gotcha, STATE §3 / gotchas.md).

## 5. Do-NOT list
- Do NOT add a `platforms.app` column or any migration (that's graduation option G, deferred).
- Do NOT create an owning App entity/table (option E, deferred — trigger in revisit-when.md).
- Do NOT touch `OAuthMetaSchema`, `persistOAuthTokens`, or the refresh engine.
- Do NOT name anything `Provider` in code.
- Do NOT hide/remove the Platforms/Credentials/Profiles pages — they move to "Advanced",
  stay fully functional.
- Do NOT make "Change method" an in-place `Platform.kind` mutation — compose shipped ops.
- Do NOT return raw core types at the web edge — metadata-only DTOs.

## 6. Report-back (what the builder returns)
- Files created/changed; `pnpm verify` result (paste tail); the grouping positive-control
  test output; confirmation the inc-29 flow is unchanged (byte-identical badges); any
  attribution edge cases found (what landed in "other" and why); whether the cli slice shipped
  or deferred.

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
