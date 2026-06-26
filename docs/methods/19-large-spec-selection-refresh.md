# Method File 19 — Large-spec selection (`--tag`/`--path`) + `platform refresh`

> **Big specs are currently un-addable, and specs go stale.** An OpenAPI spec with more than `maxTools` (default 75) operations is *refused* at `platform add` with "too many operations" (GitHub, Stripe, etc.) — the message even says "narrow with selection (coming in a later release)". This increment ships that selection: `--tag`/`--path` filters the spec to a slice that fits the cap. And `platform refresh` re-pulls a spec that changed upstream. Both are source-agnostic OpenAPI-provider features.
>
> **The load-bearing subtlety:** the runtime provider re-extracts tools from the **full cached spec** on every `listTools` (`provider.ts:35`). So a selection applied only at add-time would be ignored at serve/debug time — the full over-cap set would leak. **Selection must be persisted in the descriptor and applied at runtime too.**
>
> **Builder:** Sonnet.

---

## Part 1 — Spec (what & why)

### Goal

- **`platform add --kind openapi … --tag <t> --path <p>`** (both repeatable) adds only the operations matching the selection; the cap is checked against the **selected** count, and the selection is **persisted** so serve/debug expose exactly that slice. A spec over the cap with no selection still fails — but now the message tells you which tags to pick.
- **`platform refresh --id <id>`** re-fetches an openapi platform's spec from its stored URL, re-parses, re-resolves the base URL, re-applies the stored selection + cap, re-caches, and updates the descriptor — reporting the tool-count delta. Refuses (keeping the old working spec) if the refreshed spec would exceed the cap.

Proof: a local spec with ~120 operations across tags `pet`/`store`/`user` is refused without selection; `--tag pet` adds just the pet operations (under cap); `debug probe` shows only `pet` tools; editing the local spec + `platform refresh` reports the count change.

### What exists vs the gap

- `extractTools(schema, cap)` (`openapi-client/tools.ts:171`) walks `schema.paths` × HTTP methods → builds tools; returns `too-many-tools{count,cap}` over cap. `countOperationsByTag(schema)` gives the tag breakdown for the message.
- Runtime: `provider.ts:35` calls `extractTools(schema, cap)` on the **full** cached spec each `listTools`.
- `OpenApiConnectionSchema` (`core/schema/openapi-connection.ts`) has `spec`, `baseUrl`, `auth`, `defaultHeaders`, `maxTools` — **no selection field**.
- `platform add` (`platform.ts`): `extractTools(schema, maxTools)` for the count check; persists via `repos.platforms.create`; caches the deref'd spec to `~/.junction/openapi/<id>.json` (`platform.ts:303-311`). `repos.platforms.upsert` exists (replaces all fields) — the update path for refresh.
- **Gaps:** (1) no way to filter a big spec → un-addable; (2) no selection persistence → can't apply a slice at runtime; (3) no `refresh`.

### The change

1. **Schema** — add to `OpenApiConnectionSchema`: `select: z.object({ tags: z.array(z.string().min(1)).optional(), paths: z.array(z.string().min(1)).optional() }).optional()`. Absent ⇒ all operations (today's behavior). Source-agnostic.
2. **`extractTools(schema, cap, select?)`** — before counting/building, filter operations by the selection. An operation is **included** when `select` is absent/empty, OR its `tags` intersect `select.tags`, OR its `path` **prefix-matches** any `select.paths` entry (path starts with the given string; e.g. `--path /pet` ⇒ `/pet`, `/pet/{petId}`, `/pet/findByStatus`). `--tag` + `--path` together ⇒ **union** (match ANY). The cap applies to the **selected** count. Add an internal `operationMatchesSelection(path, operation, select)` helper. `countOperationsByTag` stays (drives the message).
3. **Runtime** — `provider.ts:35` passes `connection.select` to `extractTools`, so served/probed tools match the persisted slice exactly.
4. **`platform add`** — `--tag` and `--path` (repeatable, via the existing `collectRepeatableFlag` used for `--allow`/`--deny`). Build `select` (omit when empty); pass to the `extractTools` count-check; store it in the descriptor. Update the `too-many-tools` message: keep the tag breakdown, replace "coming in a later release" with "narrow with --tag <name> and/or --path <prefix>".
5. **`platform refresh --id <id> [--json]`** (new subcommand) — openapi only (mcp/unknown kind → clear error). Requires the stored `spec.from === "url"` (inline/file → "cannot refresh a spec that wasn't added from a URL"). Re-`parseSpec({from:"url", url})` → re-`resolveSpecBaseUrl(newSchema, url, undefined)` (re-derive from the refreshed `servers`; on `no-base-url`/`{var}` keep the **existing** stored `baseUrl`) → re-`extractTools(newSchema, maxTools, select)`:
   - over cap ⇒ **refuse**, keep the old cached spec + descriptor, report the new tag breakdown (don't clobber a working platform).
   - ok ⇒ re-cache the deref'd spec, `repos.platforms.upsert` the descriptor (preserving `auth`, `select`, `maxTools`, `displayName`; updating `baseUrl` if re-resolved), report `old N → new M tools`.

### Invariants / edges

- **Selection persists and is enforced at runtime** — serve/debug never expose more than the stored slice. (Mirrors the toolFilter discipline: filter on BOTH the count-check and the runtime extract.)
- **No selection ⇒ unchanged behavior** (all ops, today's cap semantics).
- **Path match is prefix, tag match is membership, multi-select is union** — documented; deterministic.
- **`refresh` never clobbers a working platform** on an over-cap or fetch failure — it refuses and leaves the old spec/descriptor intact.
- **`refresh` re-resolves base URL** from the new spec but falls back to the existing one (so a spec that drops its `servers` on refresh doesn't break a working platform).
- **Source-agnostic** — no vendor/path-specific logic; selection is generic tag/path.
- **Secrets** — untouched; selection + refresh are spec/config operations, no credential involved.

### Proof of done

- `pnpm verify` with tests:
  - `extractTools` selection: tag-only filter; path-prefix filter; tag+path union; empty/absent select ⇒ all; selected count under cap passes while full count is over; an operation with no matching tag/path is excluded.
  - `operationMatchesSelection`: membership + prefix + union edge cases (untagged op, path `/pet` vs `/pets`, multiple tags).
  - Runtime `provider`: a connection with `select` lists only the selected tools (over a spec whose full set exceeds the slice).
  - `platform add`: a >cap local spec refused without selection (message names tags + `--tag`/`--path`); with `--tag pet` adds the pet slice (persisted `select` in the descriptor); `--path /store` adds the store slice.
  - `platform refresh`: re-pull a (local) spec, report the count delta; a non-openapi platform → error; a `from:"inline"` spec → error; a refreshed spec that exceeds cap → refuses + keeps the old descriptor (assert DB unchanged).
- `pnpm build`; `pnpm depcruise` (0 errors); `pnpm quality` (0 clones). SPDX on any new file. Schema change is additive (no migration — `openapi` is a JSON column).
- **MANUAL QA (orchestrator):** a local multi-tag over-cap spec → `platform add` refused → `--tag` slice added → `debug probe` shows only that slice → edit the spec → `platform refresh` reports the delta. Plus a real spec if a convenient over-cap one is reachable (note it if petstore-scale is too small to exercise the cap).

### Out of scope

- Exclusion (`--exclude-tag`), glob/regex path matching (prefix only), per-operation overrides, interactive selection. Re-deriving `auth` on refresh (kept as stored). MCP-source refresh (no spec). Web UI. GraphQL.

---

## Part 2 — Implementation

### Step 1 — schema (additive)
`core/schema/openapi-connection.ts`: add the optional `select` object. Export any needed type. No migration (JSON `openapi` column).

### Step 2 — extractTools + runtime
`openapi-client/tools.ts`: add the optional `select` param + `operationMatchesSelection`; filter before count/build. `openapi-client/provider.ts:35`: pass `connection.select`. Keep `countOperationsByTag` as-is.

### Step 3 — platform add
`platform.ts`: add `--tag`/`--path` (repeatable) to the openapi args; build `select`; pass to the `extractTools` count-check; include `select` in the `OpenApiConnectionSchema` object. Update the too-many-tools message.

### Step 4 — platform refresh
New `refreshCommand` (`platform refresh --id --json`): load platform → openapi+`spec.from==="url"` guards → parseSpec → resolveSpecBaseUrl (fallback to existing) → extractTools(select, maxTools) with the over-cap refusal → re-cache spec → `repos.platforms.upsert`. Reuse the existing cache-write + error reporters. Register under the `platform` command's subcommands.

### Step 5 — tests + skill + verify
Tests per Proof-of-done (selection unit + runtime + add + refresh, incl. the no-clobber refusal). Update `junction-dev` skill: `--tag`/`--path` selection for big specs, `platform refresh`. `docs/futures/gotchas.md` if anything subtle surfaces (e.g. selection-must-persist-or-runtime-leaks). `pnpm verify`/`quality`/`depcruise`/`build`. SPDX. Commit; push; PR.

---

## Review (background, after build)

- **`ce-correctness-reviewer`** (lead): selection filtering correct on BOTH the add count-check and the runtime extract (no runtime leak of unselected tools); union/prefix/membership semantics; refresh's over-cap **no-clobber** (DB + cache left intact on refusal); base-URL re-resolve fallback; inline/non-openapi guards.
- **`junction-clean-code-reviewer` + `junction-package-boundary`**: `select` schema in core, filter in openapi-client (lib), cli orchestrates (app→lib); typed errors; thin edges; `collectRepeatableFlag` reused (no new arg-parsing dup); SPDX.
- **`junction-mcp-contract`**: a selected platform lists/calls only its slice through serve + debug; namespacing/cap unaffected.
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** add a big spec with `--tag`/`--path` (or watch it refuse without), `debug probe` the slice, `platform refresh` an existing one and see the count delta. **QA'd by me:** drove a local over-cap multi-tag spec through add-refuse → `--tag` slice → probe → edit → refresh, plus the over-cap refusal leaving the descriptor intact. **Checklist:** selection persisted + enforced at runtime (no leak), cap on selected count, union/prefix/membership semantics, refresh re-pull + delta, refresh no-clobber on over-cap/failure, base-URL re-resolve fallback, additive schema (no migration), source-agnostic.

## User test gate

```bash
pnpm build
# a real over-cap spec, sliced by tag (example; substitute any large spec):
JUNCTION_HOME=/tmp/jt19 node packages/cli/dist/index.js init
JUNCTION_HOME=/tmp/jt19 node packages/cli/dist/index.js platform add --id big --kind openapi \
  --display-name Big --spec-url <large-openapi-spec-url>            # refused: lists tags + --tag/--path
JUNCTION_HOME=/tmp/jt19 node packages/cli/dist/index.js platform add --id big --kind openapi \
  --display-name Big --spec-url <large-openapi-spec-url> --tag <tag>   # adds just that slice
JUNCTION_HOME=/tmp/jt19 node packages/cli/dist/index.js debug probe --platform big   # only the slice
JUNCTION_HOME=/tmp/jt19 node packages/cli/dist/index.js platform refresh --id big    # re-pull + delta
```
Approve → next: GraphQL provider, then Web UI, then OAuth.
