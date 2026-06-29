# Increment 25 — Web UX v2 (IA + Settings/host + tabular Credentials/Profiles + profile editing)

> **Builder: read first, in order.** `docs/STATE.md` (state), `CLAUDE.md` (architecture + behaviours),
> `docs/behaviours/verify-the-artifact.md` (a green gate ≠ a working product — drive the real built artifact in
> BOTH themes), `docs/rules/web.md` (web MUST/MUST-NOT: server-only-core boundary, tokens-only — now gated by
> `web:css-tokens`, a11y, anti-slop), `docs/design/DESIGN.md` (the design system — this increment EXTENDS it;
> update the decision log), `docs/futures/gotchas.md` (esp. the web-mutation pattern, the SSR/no-flash notes,
> the stale-`.tsbuildinfo` trap, the stale-`src/**/*.js` trap, the CLI-flake `projects` split). Then this file.
> Self-contained.

## 1. What & why

A user-driven design + functionality revision of the web dashboard (13 items, gathered from real usage of the
24.6 UI). It does three kinds of work: **(a) IA + polish** (theme, sidebar groups, dashboard composition,
badge/table/empty-state patterns adapted from the design reference), **(b) a new Settings surface + a real MCP
host** (config-backed + `JUNCTION_MCP_HOST` env), and **(c) tabular restructure + the first profile-mutation
write-path** (Credentials → flat paginated table; Profiles → master-detail with route editing; fix the
Credentials ⋯ click bug). Chosen layout direction: **Variant C** (see `scratchpad/mock-C-combination.html` —
the approved mockup; reproduce its structure with the real components/tokens).

This pulls some inc-26 (profile mutations) work forward by user request. The design reference whose **patterns**
(badges, tables, data shape) we adapt — NOT its retired amber colors — is
`/Users/maverick/.gstack/projects/amitray007-junction/designs/design-system-20260628/preview.html`.

### Non-goals / honesty guards (do NOT violate)
- **Still no working HTTP MCP endpoint.** The server is stdio-only. The Settings `mcpHost` is the *future shared
  endpoint host*; Connect-an-Agent shows a **real, copyable** `https://<host>/mcp` config built from it, but it
  MUST carry a quiet, honest note that the shared HTTP endpoint isn't live yet (today = stdio
  `junction mcp serve --profile <name>`). Do NOT claim a working endpoint or add an HTTP transport.
- **Credential kind is `bearer` only in reality.** The schema enum lists more (`api-key/bearer/oauth2/file/env`)
  but the add-path only writes `bearer`. The UI MUST render the **true** stored kind — do NOT fabricate
  oauth/apiKey labels (the mockups showed varied kinds for taxonomy illustration; the shipped UI shows truth).
- **No keys backend.** "Keys → profile" / "N keys active" stays **ComingSoon** (subtle — see item 10).
- **Credentials stay metadata-only**; secrets never in any component/loader/response (existing invariant).

## 2. Hard invariants (load-bearing)
1. **Server-only-core boundary** preserved: no `@junction/core`/`better-sqlite3`/`@napi-rs/keyring` in any
   client-reachable module; all core access via `createServerFn` → `*.server.ts`. `web:leakcheck` + `web:smoke`
   stay green. New mutations follow the inc-24 pattern (gotchas.md "web write-path"): POST `createServerFn` in a
   `*.functions.ts` (pure validator) → `.handler()` calls `assertLocalHost()` then a thin `*.server.ts` helper →
   route calls fn, `await router.invalidate()` + sonner toast. Memoized `getDb()` from `shared.server.ts`.
2. **Tokens-only** — every value a token in `app.css` (the `web:css-tokens` gate now FAILS the build on an
   undefined `var(--x)`; record any NEW token in DESIGN.md first). No magic hex/px in components.
3. **Light AND dark first-class**; the SSR no-flash mechanism (data-theme on `<html>` pre-hydration) MUST NOT
   regress. Do NOT regress the smoke-gated `<html data-sidebar>` attribute or the stylesheet `<link>`.
4. **a11y + anti-slop** (web.md + DESIGN.md): semantic HTML, visible blue focus ring on every interactive
   element, status = dot+text (never color-only), keyboard-reachable (incl. the new ⋯ menus + master-detail +
   pagination), reduced-motion-safe. Re-run the anti-slop checklist.
5. **Every change ships QA-able**: `pnpm verify` green (incl. `verify:web`: build + leakcheck + **css-tokens** +
   smoke + web tests), plus a `junction-web-verify` browser pass on BOTH themes + component tests for each new/
   changed surface and primitive.

## 3. The 13 items (grouped; each is a checkable deliverable)

### Group A — Theme + chrome
**A1. Remove the "system" theme; light|dark only.** `ui/sidebar.tsx`: `THEME_CYCLE = ["light","dark"]`, drop the
`Monitor`/system icon + "Theme: System" label + the `"system"` branch in `applyTheme`/`readStoredTheme`/
`getServerSnapshot`. The toggle becomes a 2-state light↔dark switch (Sun/Moon). **SSR no-flash:** today the
server default is "system" (neutral). With system removed, pick a concrete default: **default = dark** (matches
the design reference + the user's primary use), but seed from `prefers-color-scheme` on first paint in the
`THEME_SCRIPT` so an unset user still gets their OS preference once, then it's explicit light|dark in
localStorage + `data-theme` on `<html>`. Verify no flash in both themes (the smoke test asserts the attribute
mechanism; the THEME_SCRIPT must set a concrete light|dark pre-hydration). The Settings page (A-group + D)
also exposes the theme toggle (item 5).

**A6. Remove the "Manage" group label** at the sidebar top.

**A7. Sidebar nav groups (two groups, no "Manage" header):**
- Group 1 (top): **Dashboard**, **Settings**.
- Group 2: **Platforms**, **Profiles**, **Credentials** (in that order).
Use a subtle group separator (a hairline or a small gap — NOT a heavy "MANAGE"-style mono eyebrow; that's the
look item 6 removes). `Settings` is the NEW route (item 5). Keep counts where they make sense (Platforms/
Profiles/Credentials may show counts; Dashboard/Settings don't). Active = `--gray-100` bg + `--gray-1000` text
(no stripe). Keep ⌘B collapse + the SSR/cookie no-flash mechanism intact.

### Group B — Components / patterns (adapt the design reference — item 4)
**B2. Fix heading/subtitle + badge alignment.** Audit `ui/page-header.tsx`: the title (`--text-h1`) + the count
chip + the subtitle/lede + the right-aligned actions are misaligning (vertical baseline / centering). Fix so:
title row = `[title] [count-chip]` baseline-aligned on the left, primary action right-aligned, the lede on its
own line below at `--text-body`/`--gray-700`. Audit `StatusBadge`/`Badge` alignment (the dot + label must be
vertically centered; consistent height). The count chip next to the h1 must sit on the title's baseline, not
float.

**B4. Adopt the reference badge + table + data patterns (mapped to OUR blue/Geist tokens):**
- **Badge:** dot + label, tinted bg (`color-mix(in srgb, <status-fg> 12%, transparent)`), 1px border
  (`color-mix(in srgb, <status-fg> 30%, transparent)`), fixed ~20–22px height, consistent baseline. Keep the
  taxonomy: **Configured** (default, `--status-configured-fg`), **Connected** (`--status-ok-fg`, reserved/probe
  inc 28), **No Auth** (`--status-noauth-fg`), **Expiring** (`--status-warning-fg`), **Auth Failed**
  (`--status-error-fg`), **Off/Disabled** (`--status-off-fg`). (`color-mix` is already used in the codebase —
  states.tsx — and is allowed.) Update `ui/badge.tsx` + its test.
- **Table:** bordered, rounded (`--radius-6`), header row on `--bg-200` with `--gray-700` ~12px labels (NOT
  uppercase-mono eyebrows on every column — keep them quiet), hairline rows (`--alpha-200`), ~44px rows, hover
  `--gray-100`, mono (`--font-mono`) for IDs/namespaces/counts (tabular-nums), trailing `⋯` actions cell. This
  is the existing `ui/table.tsx` — extend it (sortable header affordance + a group-divider row variant for B-C/
  item-12, + a pagination footer subcomponent). Keep TableActionsCell/Head.

**B3. Empty state = an empty TABLE, not a bare text line.** When a surface has zero rows, render the table with
its header row + a single full-width body row containing the empty message + the first action (e.g. "No
credentials yet — Add credential"). Applies to Credentials, Platforms, Profiles. Add an `EmptyTableRow` (or a
`TableEmpty` prop on the table) to `ui/`; update the three routes; keep/adjust the route tests (they currently
assert a text empty state — re-point to the empty-table).

### Group C — Dashboard (items 8, 9, 10)
**C9. Rethink the dashboard organization.** Decide a coherent, non-distorted layout (the 24.6 2-col was a step;
refine it now that Settings + the real host exist). Target structure (top→bottom, using the width):
  - **Connect an Agent** — the hero/primary block. Now uses the **real MCP host** (item 5) to render a real,
    copyable endpoint + agent config (Claude/Cursor/Raw tabs), with the honest "shared HTTP endpoint coming
    soon; today use stdio" note as a SUBTLE inline banner (item 10).
  - **At a Glance** — a clean stat strip/cards (item 8), properly aligned.
  - **System** — a quiet detail (store/sandbox/home), de-emphasized.
  - **Recent Activity** — subtle ComingSoon footer.
Keep section hierarchy explicit (primary vs secondary), vary the 8/16/40 rhythm, no identical-card monotony.

**C8. At a Glance alignment.** The current stat row looks distorted. Make the three counts a set of aligned,
equal cells/cards (consistent width/height/baseline) — a clean stat strip that doesn't break at any width.
No distortion when the dashboard column reflows (test at 1440 / ~1000 / ~700px).

**C10. Connect-an-Agent fixes:**
  - **(a) Kill card-inside-card.** Today `AgentConfig` sits inside a `<Card>` AND wraps itself in a dashed-border
    section → two nested containers. Flatten to ONE container (either the Card OR the section, not both).
  - **(b) "Key selects profile" is confusing.** Clarify or de-emphasize: since keys are ComingSoon, demote the
    key→profile chips to a single quiet line ("A junction key will select which profile an agent gets —
    coming soon") rather than a prominent labelled block. Don't lead with it.
  - **(c) ComingSoon must be SUBTLE** — a small inline banner / one-line note, not a big affordance. Audit the
    `ComingSoon` usage app-wide (Dashboard, Profiles, Platforms): the pill is fine but the surrounding treatment
    should be quiet (a thin note, not a boxed/dimmed region). Update `ui/coming-soon.tsx` if needed so the
    default rendering is subtle.

### Group D — Settings + real MCP host (item 5) — NEW BACKEND (core + web)
**D5. Settings route + the MCP host.**
- **Core:** extend `ConfigSchema` (packages/core/src/config/index.ts) with `mcpHost: z.string().optional()`
  (Zod strips unknown keys by default, so adding an OPTIONAL field is backward-compatible — old configs still
  parse; NO version bump, NO migration). Add a small resolver `getMcpHost(paths): ResultAsync<string|undefined>`
  = config.mcpHost ?? `process.env.JUNCTION_MCP_HOST` ?? undefined (env is the default when config is unset;
  config overrides? — DECISION: **config value wins if set, else env, else undefined**; document it). Add a
  setter path via the existing `saveConfig` (load → merge mcpHost → save; keep the lock/atomic write). Validate
  the host string (non-empty, a hostname/host:port shape — reject obviously bad input; do NOT require https://).
  Add core unit tests (set→get roundtrip, env fallback, config-overrides-env, clearing).
- **Web read:** add `mcpHost` to `DashboardData` (or a dedicated `getSettings` server-fn) so Connect-an-Agent +
  Settings read it. Metadata-only; no secrets.
- **Web write:** a `setMcpHostFn` POST `createServerFn` (pure validator: non-empty string / host shape →
  `.handler()` assertLocalHost → thin `settings.server.ts` calling the core setter) → `router.invalidate()` +
  toast. Follow the inc-24 mutation pattern exactly.
- **Settings UI** (`routes/settings.tsx` + nav item): a clean form — **MCP Host** (text input + Save, shows the
  resolved value + whether it came from env or config), **Theme** (the light/dark toggle from A1), and room for
  future prefs (a section structure, not a single field). PageHeader "Settings". a11y form (reuse `Field`/
  `Input` primitives). Add a route test (renders, host field, save calls the fn).
- **Connect-an-Agent uses it:** when a host is set, the endpoint/config show the REAL `https://<host>/mcp`
  (copyable — a Copy button is now legitimate since it's a real config string the user provided); when unset,
  fall back to the `<your-junction-host>` placeholder + prompt to set it in Settings. Keep the "not live yet"
  honesty note regardless.

### Group E — The ⋯ menus + profile editing (item 11) — NEW BACKEND (web; core ops mostly exist)
**E11a. Fix the Credentials ⋯ click bug.** The Radix dropdown (rotate/delete) works via keyboard (24.5 QA drove
it that way) but the user reports the ⋯ isn't *clickable*. **Reproduce the CLICK path** against the real running
server (agent-browser click on the ⋯, not keyboard) and fix the root cause — likely a z-index/portal/overlay or
pointer-events issue (e.g. the dropdown content rendering under another layer, or a row-hover element
intercepting the click). Do NOT just restyle — find why the click doesn't open it. Add a regression note.

**E11b. Profile route editing (the first profile write-path).** Wire ⋯ actions on profile route rows + profile
controls, mirroring the inc-24 credential mutation pattern. The CORE ops mostly EXIST (CLI uses them):
`add-source`, `remove-source`, `enable-source`, `disable-source` (+ `profile create`/`delete`). Expose them as
web server-fns:
  - **Toggle route on/off** → enable-source / disable-source.
  - **Remove route** → remove-source (confirm dialog).
  - **Add route** → add-source (dialog: pick platform + credential(optional) + namespace + optional filter).
    Namespace uniqueness within a profile is enforced by the DB unique index — surface the error cleanly.
  - **New profile** / **Delete profile** → create / delete (delete cascades source_refs — confirm dialog).
  - **Edit tool access** (editing an existing route's toolFilter allow/deny) = **ComingSoon this increment**
    (DECIDED — confirmed no core op exists: the source-ref repo `SourceOp` is only `delete | setEnabled`; there
    is `addSource`/`removeSource`/`setSourceEnabled` but no filter-update). The filter is set at **add-route**
    time (the Add-route dialog includes optional allow/deny). Editing a filter in place is deferred to a thin
    future core op (record in `docs/futures/revisit-when.md`). Do NOT invent a core op or fake it; show the
    filter read-only on existing routes with a subtle "edit coming soon" affordance. (A remove+re-add is the
    user's workaround today — optionally mention it in the ComingSoon hint.)
  All new fns: POST createServerFn, pure validator, assertLocalHost, metadata-only return, router.invalidate +
  toast. New `profile-mutations.functions.ts` + `profile-mutations.server.ts`. Dialogs reuse the inc-24
  dialog/field/select primitives.

### Group F — Credentials + Profiles restructure (items 12, 13) — Variant C
**F12. Credentials → flat paginated table with platform group-dividers (Variant C).** Replace the grouped-card
layout with ONE table: columns `ID (mono) · Platform (mono tag) · Account · Kind (true: bearer) · Status (badge)
· ⋯`. Insert a subtle full-width **group-divider row** per platform (platform name + kind chip + count) within
the single table — the grouping cue without separate cards. A **search** input (filter by platform/account/id),
a **Sort** affordance on a column (at least Platform/Account), and a **pagination footer** (`‹ 1 2 3 ›` +
"N of M") — page size e.g. 25; with the seed (10) it's one page but the control must render and work (test with
a page-size small enough to paginate, or assert the control + the slicing logic). Keep the inc-24 add/rotate/
delete (the ⋯ per row) wired + working (item 11a). Secrets never shown.

**F13. Profiles → master-detail (Variant C).** Left: a profiles **list** (name + source platform chips + route
count + a `›`), filterable, selecting one. Right: the selected profile's **detail** — its route rows as a table
(`Platform · Account · Namespace · Filter · Status · ⋯`) with the editing actions (item 11b), the
`junction serve --profile <name>` line, "N keys active" ComingSoon (subtle), and `New profile` / `Add route` /
`Edit tool access` controls. The split must collapse gracefully on narrow widths (stack list above detail).
No per-profile HTTP endpoint URL (single-endpoint model). Route-row field mapping is the real `SourceMeta`
(`credentialAccount`, `(none)`→No Auth badge, `toolFilter` object→compact `+N allow`/`−N deny`/"all tools",
`enabled`→on/off) — same as 24.5.

## 4. Implementation order (phased — build + verify each phase before the next)
> Order: low-risk chrome first, then backends, then the big restructure, so regressions surface early.
1. **Phase 1 — Theme + sidebar + badge/table/empty-table primitives** (A1, A6, A7, B2, B3, B4). Pure UI/
   primitives; no new backend. Verify both themes + the no-flash + the empty-table states.
2. **Phase 2 — Dashboard rethink** (C8, C9, C10). Depends on the new primitives; the real host (D5) lands
   here or just after — sequence D5-core first if Connect-an-Agent needs the host.
3. **Phase 3 — Settings + host** (D5): core config field + resolver + tests → web read/write fn → Settings
   route → wire Connect-an-Agent to the real host.
4. **Phase 4 — Credentials restructure** (F12) + **fix the ⋯ click** (E11a).
5. **Phase 5 — Profiles master-detail** (F13) + **profile route editing** (E11b).
6. **Phase 6 — tests + QA sweep** across all surfaces, both themes.

## 5. Proof-of-done
- [ ] `pnpm verify` green (incl. `verify:web`: build + leakcheck + **css-tokens** + smoke + web tests) Node 20+22;
      `pnpm depcruise` clean; `pnpm dup` ≤ threshold; `web:css-tokens` green (no undefined tokens).
- [ ] Theme is light|dark only (no "system"); no-flash holds in both; Settings exposes the toggle.
- [ ] Sidebar: no "Manage" label; two groups [Dashboard, Settings] · [Platforms, Profiles, Credentials].
- [ ] Heading/subtitle/badge alignment fixed (PageHeader + Badge); badges match the reference pattern (dot+text,
      tinted+bordered, centered).
- [ ] Empty states render as an empty TABLE (header + message row), not bare text, on all 3 list surfaces.
- [ ] Dashboard: coherent hierarchy, At-a-Glance aligned (no distortion at 1440/1000/700px), Connect-an-Agent
      has NO card-in-card, key→profile demoted, ComingSoon subtle.
- [ ] Settings route works: MCP host reads `JUNCTION_MCP_HOST` default, persists to config, survives reload;
      Connect-an-Agent shows the REAL `https://<host>/mcp` (copyable) when set, placeholder + "set in Settings"
      when unset; the "shared HTTP endpoint coming soon / today stdio" honesty note present.
- [ ] Credentials ⋯ opens on CLICK (not just keyboard); rotate/delete still work end-to-end; secret never shown.
- [ ] Profile editing: add/remove route, toggle on/off, new/delete profile all work end-to-end (driven against
      the real server); namespace-uniqueness + delete-while-routed errors surface cleanly. (Edit-tool-access
      wired IF a core op exists, else ComingSoon — note which.)
- [ ] Credentials = flat paginated table + group-dividers + search/sort (Variant C); kind shows TRUE `bearer`.
- [ ] Profiles = master-detail (Variant C), collapses on narrow; no per-profile endpoint URL.
- [ ] Both themes verified against the REAL built/running server via `junction-web-verify`; anti-slop re-checked.
- [ ] DESIGN.md decision log updated (theme light|dark, sidebar groups, Variant C tables, real host, subtle
      ComingSoon); web.md updated if any rule shifts; new tokens (if any) recorded in DESIGN.md first.

## 6. Reviewers (step 6 gate)
`junction-web-reviewer` (all surfaces + a11y + anti-slop + boundary + the new tabular/master-detail/pagination),
`junction-credential-security` (the Credentials restructure + the new mutations must not leak a secret; confirm
metadata-only survives), `junction-package-boundary` (new server-fns + the core config change keep the boundary;
no core in client), `ce-correctness` (the new mutation logic: profile editing, namespace-uniqueness, host
validation), `ce-maintainability` (the table/primitive extensions, dead code, duplication, the dashboard rework),
`ce-testing` (the new surfaces + mutations + pagination/sort logic + both-theme renders). Run `junction-web-verify`
in BOTH themes + the anti-slop checklist explicitly.

## 7. User test gate
Visually testable: **yes** (the whole UI). After build + seed (the `scratchpad/seed-jtest.sh` rich seed, or
`/tmp/jtest`):
`JUNCTION_HOME=/tmp/jtest JUNCTION_STORE=file PORT=4321 node packages/web/serve.mjs` → walk all surfaces in
BOTH themes; confirm each of the 13 items; set an MCP host in Settings and see Connect-an-Agent update; add/
toggle/remove a profile route; open the Credentials ⋯ and rotate; page/sort the credentials table.

## 8. Notes
- This increment pulls inc-26 (profile mutations) forward. After it, the method map's inc 26 becomes "remaining
  profile/source work + the keys backend direction" — reconcile `docs/methods/README.md` at handover.
- The mockup that defined Variant C is `scratchpad/mock-C-combination.html` (throwaway; not in the repo).
- End with the 3-part end-of-increment report + run the `junction-handover` reflection step. If profile-filter
  editing needs a new core op, record the decision (built vs deferred) in `docs/futures/`.
