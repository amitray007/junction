# Increment 26 — Web: platform & route management

_The first increment planned as a **mode-A wave** (`docs/methods/_waves.md`): one blocking
shared slice, then independent leaf slices fanned out to parallel Sonnet subagents and
integrated serially in the one working tree (no worktrees — see `CLAUDE.md` → "Plan for
parallelism by default")._

---

## 1. What & why

Two web write-paths currently show **"Coming soon"** and this increment makes them real,
over **one shared orchestration extraction** so the CLI and web stop diverging:

1. **Platforms** page says _"Add via `junction platform add` — UI coming soon"_ → give the
   web **add / edit / delete** of platforms (all 5 kinds: mcp-http, mcp-stdio, openapi,
   graphql, cli), plus **refresh** for openapi.
2. **Profiles → route → Edit tool access** is read-only (_"Edit coming soon — remove and
   re-add"_) → give the web **in-place toolFilter editing** (change a route's allow/deny
   without remove+re-add).

**Why together:** both are web write-paths that need a `core`-side op that doesn't exist
yet. Platform add/refresh assembly lives **only in the CLI** today (`parseSpec` →
`extractTools` → `resolveSpecBaseUrl` → build connection → wrap → cache → upsert); the web
can't reach it (`web → cli` is a forbidden app→app edge). And the source-ref `SourceOp` has
no `setFilter`. So both share the shape "**land a reusable backend op first, then fan out
the web + cli consumers**" — a textbook wave.

### Non-goals / honesty guards (do NOT violate)

- **No new HTTP MCP endpoint, no keys.** That's inc 27 (junction-keys). Platform/route
  management does not touch serving or auth.
- **Credential kind stays `bearer`-only.** Platform add in the web reuses the existing
  credential model; no new auth schemes.
- **Metadata-only across the web boundary.** Platform/route mutations return
  `{ok:true} | {ok:false; error}` or metadata DTOs — never raw core types, never secrets.
- **No behaviour change to the CLI.** Slice B rewires `platform.ts` onto the extracted
  package; `platform add`/`refresh` output + validation stay byte-for-byte equivalent
  (snapshot-guard the `--json` output).
- **Filter editing is a source property, not a platform one.** `setRouteFilter` lives in
  `profile-mutations.*`, NOT the new platform-mutations file.

---

## 2. Hard invariants (load-bearing)

- **Dependency direction — and the invariant this increment RELAXES (decide before build).**
  `core` imports nothing in-repo. The openapi/graphql orchestration needs
  `@junction/openapi-client` + `@junction/graphql-client`, and **those depend on `core`** —
  so it **cannot live in `core`** (would reverse the arrow). It lives in a new lib
  `@junction/platform-orchestration` (deps: core + both clients). **⚠️ This makes it the
  FIRST lib→lib dependency in the repo.** The current `libs-import-only-core` depcruise rule
  is explicit and deliberate: _"a lib may import ONLY core + its own files — never a peer
  lib."_ No lib→lib edge exists today. So this increment **consciously relaxes that
  invariant** to "a lib may import core + other libs (a lib DAG), never an app." That is a
  real architectural change, not a config tweak — it's called out here, in `README.md`, and
  in `docs/futures/`, and `junction-package-boundary` must sign off. **The alternative that
  avoids it** (orchestration lives in `web` with its own client deps, cli keeps its own) was
  weighed and rejected: it duplicates the assembly across cli+web — the exact DRY violation
  the extraction exists to remove. We accept the relaxed invariant because a lib DAG rooted
  at core is still acyclic + one-directional (apps still never imported by libs); the
  no-app-import half of the rule is untouched.
- **Server-only-core boundary in web.** New platform mutations touch core (via the new
  package) ONLY in `*.server.ts`; the `*.functions.ts` RPC layer stays client-safe;
  `web:leakcheck` must stay green (the new package + `@scalar/openapi-parser` + `graphql`
  must NOT appear in `dist/client`).
- **`assertLocalHost()` first in every mutation handler.** Same pattern as inc 24/25.
- **`SourceOp` stays a total discriminated union.** Adding `{kind:"setFilter"}` means
  `runSourceMutation`'s dispatch must handle it exhaustively (no `else` fall-through that
  silently mis-handles a new kind).
- **`toolFilter` is stored as JSON** (`sourceRefs.toolFilter` = `JSON.stringify` / parsed
  via `ToolFilterSchema`). `setFilter` with `undefined`/empty clears it to `null` (no filter
  = all tools) — round-trip must be exact.

---

## 3. The wave — slices + frontmatter

Five slices. **A1 ∥ A2** land first (different packages, no collision), then **B, C, D**
fan out. All in the ONE working tree via subagents; integrate serially with `pnpm verify`
between each (§5).

### Dependency graph

```
A1 (new pkg: platform-orchestration)   A2 (core: SourceOp setFilter)
        │                                       │
   ┌────┴────┐                                  │
   ▼         ▼                                  ▼
   B (cli)   C (web: platform CRUD)        D (web: filter edit)
```

- **A1 and A2 are independent** (different packages) → same wave.
- **B depends on A1** (cli rewires onto the new package).
- **C depends on A1** (web platform mutations call the new package).
- **D depends on A2** (web filter mutation calls the new core op).
- **B, C, D are mutually independent** — B touches `cli`, C touches `web` (platforms
  route + new platform-mutations files), D touches `web` (profiles route +
  profile-mutations files). **C and D share the `web` package but ZERO files** (different
  routes, different mutation modules) → they may co-run. **Coordination point:** if both
  need a new `ui/index.ts` export, that's a 1-line collision — resolve at integration
  (apply C, then D rebases the barrel line).

### Per-slice frontmatter (goes at the top of each slice's builder brief)

```yaml
# Slice A1 — extract platform orchestration to a new lib
increment: 26
title: "@junction/platform-orchestration — extract platform add/refresh from cli"
depends_on: []
soft_after: []
touches: [platform-orchestration, ci]   # new pkg + workspace/tsconfig/depcruise wiring
parallel_group: A
```
```yaml
# Slice A2 — core SourceOp.setFilter
increment: 26
title: "core: SourceOp {kind:setFilter} + setSourceFilter repo op"
depends_on: []
soft_after: []
touches: [core]
parallel_group: A
```
```yaml
# Slice B — cli rewires onto the extracted package
increment: 26
title: "cli: platform.ts calls @junction/platform-orchestration (no behaviour change)"
depends_on: [26-A1]
touches: [cli]
parallel_group: B
```
```yaml
# Slice C — web platform add/edit/delete
increment: 26
title: "web: platform add/edit/delete/refresh (platform-mutations.* + platforms.tsx)"
depends_on: [26-A1]
touches: [web]          # routes/platforms.tsx + NEW platform-mutations.{functions,server}.ts
parallel_group: B
```
```yaml
# Slice D — web toolFilter edit-in-place
increment: 26
title: "web: edit route tool-access in place (setRouteFilterFn + editable chips)"
depends_on: [26-A2]
touches: [web]          # routes/profiles.tsx + profile-mutations.{functions,server}.ts
parallel_group: B
```

---

## 4. The slices in detail

### Slice A1 — new lib `@junction/platform-orchestration` (BLOCKING)

**Create the package** `packages/platform-orchestration/`:
- `package.json` — `name: "@junction/platform-orchestration"`, deps: `@junction/core`,
  `@junction/openapi-client`, `@junction/graphql-client`, `neverthrow`. tsdown build like
  the other libs.
- `tsconfig.json` — `references` to core, openapi-client, graphql-client (so `tsc -b`
  orders the build; see the inc-2 carry-forward note in `README.md`).
- Add to `pnpm-workspace.yaml` if it globs `packages/*` (it does — verify).

**Extract these functions** from `packages/cli/src/commands/platform.ts` (verbatim logic;
strip only the CLI shell — argv parsing, `consola`, `--json`, `reportError`). Each returns
a neverthrow `Result` with a discriminated `PlatformOrchestrationError`:

```ts
addMcpPlatform(input: { id; displayName; transport:"http"|"stdio"; url?; command?;
  args?; authHeader?; tokenEnvVar? }): ResultAsync<Platform, PlatformOrchestrationError>

addOpenApiPlatform(input: { id; displayName; specUrl; baseUrl?; auth?; maxTools?;
  select?:{tags?;paths?} }): ResultAsync<{platform:Platform; toolCount:number;
  cacheWritten:string}, PlatformOrchestrationError>
  // parseSpec → extractTools (cap-check → err with tag breakdown) → resolveSpecBaseUrl →
  //   derive/validate auth → OpenApiConnectionSchema → PlatformSchema → write spec cache.
  // NOTE: cache write (writeFile to getPaths().openapi) — keep it here; both cli+web want it.

addGraphQlPlatform(input: { id; displayName; endpoint; auth?; defaultHeaders? }):
  ResultAsync<{platform:Platform; sdlCached:boolean}, PlatformOrchestrationError>
  // validate endpoint → build auth (reject apiKey-in-query) → introspectSchema (optional,
  //   warn-not-fail) → GraphQlConnectionSchema → PlatformSchema.

addCliPlatform(input: { id; displayName; descriptor:unknown }):
  ResultAsync<{platform:Platform; toolCount:number}, PlatformOrchestrationError>
  // JSON-parse descriptor → CliConnectionSchema → probe createSandbox() caps (warn) →
  //   validatePolicy per tool (early reject) → PlatformSchema.

refreshOpenApiPlatform(input: { platformId; platformsRepo }):
  ResultAsync<{platform:Platform; oldCount?:number; newCount:number}, PlatformOrchestrationError>
  // repo.get → assert kind openapi + spec.from==="url" → parseSpec → resolveSpecBaseUrl
  //   (fallback old) → extractTools (refuse if cap exceeded) → re-cache → upsert.
```

- **Persistence stays a repo call the CALLER passes in** (don't have this package open the
  DB). `add*` return the assembled `Platform`; the caller does `repos.platforms.upsert()`
  (or pass the repo in, as `refresh` does). Keep the package **I/O-light**: it does spec
  fetch + file cache (unavoidable for openapi), but not DB lifecycle. This preserves core's
  "no daemon" spirit and keeps the functions unit-testable.
- **Tests (Vitest, in-package):** each `add*` with a fixture spec/descriptor →
  assert the assembled `Platform` + error paths (too-many-tools returns the tag breakdown;
  bad descriptor → typed err). Mirror the existing openapi/graphql-client test style.
- **`depcruise` wiring:** confirm the new package satisfies `libs-import-only-core` — it
  imports `core` + `openapi-client` + `graphql-client`, all libs. If the rule reads
  "import ONLY core", the two client imports will trip it → **the rule needs a narrow
  amendment** (a lib may import core + other libs, never an app). Read
  `.dependency-cruiser.cjs` and make the minimal correct change; this is the ONE
  boundary-config edit and must be reviewed by `junction-package-boundary`.

**Proof:** `pnpm --filter @junction/platform-orchestration test` green; `pnpm depcruise` 0
errors; the package builds under `tsc -b`.

### Slice A2 — core `SourceOp.setFilter` (BLOCKING, tiny)

In `packages/core/src/repositories/profiles.ts`:
- Extend the union (line 43):
  `type SourceOp = {kind:"delete"} | {kind:"setEnabled"; enabled} | {kind:"setFilter"; toolFilter?: ToolFilter}`
- In `runSourceMutation` (lines ~66–73): replace the `if delete / else setEnabled` with an
  **exhaustive** switch on `op.kind`; the `setFilter` branch:
  `tx.update(sourceRefs).set({ toolFilter: op.toolFilter ? JSON.stringify(ToolFilterSchema.parse(op.toolFilter)) : null }).where(...)`.
- Add repo method:
  `setSourceFilter(profileId, toolNamespace, toolFilter?: ToolFilter): ResultAsync<void, DbError>`
  → `runSourceMutation(db, profileId, toolNamespace, { kind:"setFilter", toolFilter })`.
- Export nothing new from `index.ts` unless `ToolFilter` isn't already exported (it is via
  the source-ref schema — verify).
- **Tests:** extend `repositories.test.ts` — set a filter on an existing route, read it
  back (allow-only, deny-only, both, and clear→null); assert the JSON round-trips and that
  an unknown namespace errors.

**Proof:** `pnpm --filter @junction/core test` green; the union is exhaustive (tsc errors if
a `kind` is unhandled).

### Slice B — cli rewires onto the package (LEAF, depends A1)

- `packages/cli/src/commands/platform.ts`: replace the inlined assembly in `add` +
  `refresh` with calls to the new package's `add*Platform` / `refreshOpenApiPlatform`; keep
  ALL the CLI shell (argv, `@clack`/`consola`, `--json`, cache-path messaging, error
  reporting). The CLI now: parse argv → call the orchestration fn → on ok
  `repos.platforms.upsert` + report → on err map to the existing CLI error output.
- `packages/cli/package.json`: add `@junction/platform-orchestration` dep (cli already deps
  both clients + core; this replaces the direct `parseSpec`/`extractTools` imports).
- **No behaviour change.** Guard it: snapshot the `platform add --json` + `platform refresh
  --json` output for each kind against a fixture before/after (a small vitest or a scripted
  diff). If output drifts, the extraction changed semantics — stop.

**Proof:** `pnpm --filter junction test` green; drive the REAL built CLI: `platform add`
for all 5 kinds + `platform refresh` against `/tmp/jtest`, output identical to pre-slice.

### Slice C — web platform add/edit/delete/refresh (LEAF, depends A1)

- **New** `packages/web/src/server/platform-mutations.functions.ts` +
  `platform-mutations.server.ts` (mirror `profile-mutations.*`): server-fns
  `addPlatformFn` / `updatePlatformFn` / `deletePlatformFn` / `refreshPlatformFn`, each
  `assertLocalHost()` → a `*.server.ts` helper that imports the orchestration package (in
  `.server.ts` ONLY) + `withRepos`, returns `{ok:true; platform?:PlatformMeta} | {ok:false;
  error}`.
  - **add**: dispatch by kind to the matching `add*Platform`, then `repos.platforms.upsert`.
  - **edit**: for v1, edit = re-run add with the same id (upsert replaces). Note: a true
    partial `update` repo op is deferred — upsert-replace is acceptable (record in futures
    if it bites). Delete = `repos.platforms.delete(id)` (guard: refuse if a profile route
    references it? — check existing delete semantics; match the CLI's `platform remove`).
  - **refresh**: openapi only → `refreshOpenApiPlatform`.
- **UI** `packages/web/src/routes/platforms.tsx`: an **Add Platform** dialog (kind selector
  → kind-specific fields, reusing `DialogFormFooter`), a `⋯` row menu (Edit / Refresh
  [openapi] / Delete), and wire `router.invalidate()` + toast. Remove the "UI coming soon"
  hint. Delete uses the existing confirm-dialog pattern.
- **Tests:** component tests for the add dialog (kind switch renders the right fields) +
  server-fn validator tests; a happy-dom render of the ⋯ menu.

**Proof:** drive the REAL built web server (`junction-web-verify` skill) — add one platform
of each kind, edit, refresh an openapi, delete; both themes; `web:leakcheck` green (the
orchestration pkg + parsers absent from `dist/client`).

### Slice D — web toolFilter edit-in-place (LEAF, depends A2)

- **`profile-mutations.functions.ts` + `.server.ts`**: add `setRouteFilterFn` +
  `mutateSetRouteFilter({profileId, namespace, toolFilter?})` → `assertLocalHost()` →
  `repos.profiles.setSourceFilter(...)`. Validator: `toolFilter` = optional
  `{allow?:string[]; deny?:string[]}` (type-only, server Zod-validates).
- **`routes/profiles.tsx`**: the route-detail "Edit tool access" becomes editable — an edit
  dialog/inline editor for allow/deny chips (replace the read-only `ComingSoon` at ~line
  413 + the read-only hint at ~527). On save → `setRouteFilterFn` → `router.invalidate()` +
  toast. Keep the "set at add-time" path working; this just makes it mutable after.
- **Tests:** interaction test — open editor, add an allow entry, save, assert the mutation
  fires with the right payload; clear→all-tools path.

**Proof:** drive the real web server — edit a route's filter on the `dev`/`assistant`
profile in `/tmp/jtest`, verify it persists across refresh; both themes.

---

## 5. Implementation order (mode-A integration — serial in one tree)

Per `_waves.md` §5 — fan out cheap, integrate serial:

1. **Wave 1 (parallel subagents): A1 + A2** — dispatch both Sonnet builders at once
   (different packages, no collision). When each returns: apply **A2 first** (tiny, core),
   `pnpm verify`; then **A1**, `pnpm verify` + `pnpm --filter @junction/platform-orchestration
   test` + `pnpm depcruise`.
2. **Wave 2 (parallel subagents): B + C + D** — dispatch all three once A1+A2 are merged in
   the tree. Integrate serially: **B** (`pnpm verify`) → **C** (`pnpm verify` + web-verify) →
   **D** (`pnpm verify` + web-verify). If C and D both edited `ui/index.ts`, rebase the
   2nd's one line.
3. After each apply, run `pnpm verify`; after C/D, **drive the real built web server** (the
   semantic-conflict catch — green-alone/red-together).
4. Full-suite gate before PR: `pnpm verify` + `pnpm dup` (0.5%) + `pnpm depcruise` (0).

> If, at build time, the increment proves narrow (e.g. the openapi/graphql extraction is
> the bulk and B/C/D are thin), it's fine to collapse to fewer subagents — the wave is the
> default lens, not a mandate (`_waves.md` §6).

---

## 6. Proof-of-done

- [ ] `@junction/platform-orchestration` exists, is a recognized lib (depcruise green), and
      the CLI + web both consume it (single source of truth — no duplicated assembly).
- [ ] `platform add`/`refresh` via the CLI produce **byte-identical** `--json` output to
      pre-increment (Slice B snapshot guard).
- [ ] Web: add/edit/delete a platform of **each** kind + refresh an openapi, driven against
      the real built server in both themes.
- [ ] `SourceOp` is an exhaustive union incl. `setFilter`; `setSourceFilter` round-trips the
      JSON filter (allow/deny/both/clear).
- [ ] Web: edit a route's tool-access in place; it persists across refresh.
- [ ] Honesty guards intact: no HTTP endpoint/keys, bearer-only, metadata-only, leakcheck
      green (orchestration pkg + parsers absent from `dist/client`).
- [ ] Gates: `pnpm verify`, `pnpm dup` < 0.5%, `pnpm depcruise` 0 errors.

---

## 7. Reviewers (step-6 gate)

- **`junction-package-boundary`** — MANDATORY (new package + the one `.dependency-cruiser.cjs`
  amendment; the web server-only-core boundary for the new mutations).
- **`junction-web-reviewer`** — the new platform + filter web write-paths (leakcheck, a11y
  on the add dialog + ⋯ menu + filter editor, tokens, tests).
- **`ce-correctness-reviewer`** — the extraction is behaviour-preserving (CLI snapshot),
  the `SourceOp` exhaustiveness, the upsert-as-edit semantics, refresh cap-refusal.
- **`ce-maintainability-reviewer`** — no new duplication (the extraction should REDUCE it;
  confirm cli+web don't re-duplicate assembly), the new package is single-purpose.
- **`ce-testing-reviewer`** — the orchestration unit tests + the web interaction tests +
  the CLI snapshot guard.
- (`ce-security-reviewer` if the platform-add path admits any new untrusted input handling
  — the descriptor/spec parsing already exists, so likely light.)

---

## 8. User test gate (step 7)

Copy-paste, against the seeded `/tmp/jtest`:

```bash
pnpm web:dev            # web on /tmp/jtest, agentation overlay
# Platforms: add one of each kind, edit a display name, refresh the Pet Store (openapi), delete one.
# Profiles → dev → a route → Edit tool access: change allow/deny, save, refresh — persists.
# CLI unchanged:
JUNCTION_HOME=/tmp/jtest JUNCTION_STORE=file ./junction platform add --id demo --kind mcp \
  --display-name "Demo" --transport http --url https://example.com/mcp --json
```

---

## 9. Notes / forward-looking

- **`docs/futures/`:** record (a) the new `@junction/platform-orchestration` package + the
  `.dependency-cruiser.cjs` "libs may import other libs" amendment as an architecture note;
  (b) **edit = upsert-replace** (no partial `platforms.update` op yet) in `revisit-when.md`
  with the trigger "a platform edit must preserve a field the form doesn't submit"; (c) any
  spec-cache / refresh gotcha surfaced.
- **Retires ComingSoons:** the Platforms "UI coming soon" hint and the Profiles "Edit tool
  access" ComingSoon. After this ships, the only remaining web ComingSoons are the
  AgentConfig shared-endpoint (inc 27) + Audit (inc 31) — both backed by numbered
  increments.
- **Sets up inc 27:** the platform-management UI patterns (dialogs, ⋯ menus over write-paths)
  are the same chrome the keys UI will reuse.
