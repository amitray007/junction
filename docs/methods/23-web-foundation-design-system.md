# Increment 23 — Web foundation: design system + quality

> **Builder: read these first, in order.** `docs/design/DESIGN.md` (the decided system —
> tokens/type/color/motion/components/badges; THE source of truth for every value),
> `docs/design/web-ui-brief.md` (intent), `CLAUDE.md` (architecture + behaviours),
> `docs/rules/` (typescript/testing/security/licensing), `docs/STATE.md` §3 (traps).
> Then this file. It is self-contained: build *from* DESIGN.md, never invent design values.

## 1. What & why

Re-skin `@junction/web` (the inc-22 read-only dashboard) onto a **real, owned, distinctive design system** and stand up the **quality scaffolding** that every later web increment (24+) depends on. Today the web UI is a single hand-written `app.css` with system fonts. After this increment it's: Geist + Departure-Mono type, a tokenized Tailwind theme (light+dark), an owned `ui/` primitive layer (shadcn pattern — Radix + cva), a status-badge taxonomy, Emil-grade motion, WCAG-AA a11y, the signature left-edge status rail, the four existing routes re-skinned — **plus** `docs/rules/web.md`, the Biome React/hooks domain, a happy-dom + Testing-Library component-test harness, the `junction-web-reviewer` agent, and a CI web gate (`vite build` + client-bundle leak-grep).

**Why now (re-slice):** the design system + the quality harness are inseparable and must land *before* the web mutation increments (24 credentials, 25 platforms, 26 profiles, 27 probe/call) so feature UI is built on a distinctive system, not retrofitted onto one.

**Why it matters:** this is the first user-facing increment with a deliberate visual identity. The bar is "instrument-grade, not AI-slop" (see DESIGN.md north star). Get the tokens + primitives + harness right and every later screen is cheap and consistent.

### Non-goals (do NOT do here)
- **No write paths / mutations.** Stays read-only. `createServerFn` mutations are inc 24+.
- **No live rail pulse, no patch-bay diagram.** Ship the **static** rail only; the pulse + diagram are futures (no live-event source exists yet).
- **No new routes / features.** Re-skin the existing four (`/`, `/platforms`, `/credentials`, `/profiles`) + the not-found component. Same data, same server fns.
- **No `@junction/core` changes.** This increment is web-only. Core is untouched.
- **No auth, no networked mode.** Localhost-only stays.

## 2. Hard invariants (load-bearing — violating any is a failed increment)

1. **Server-only-core boundary preserved (security-critical, inc-22 invariant).** No `@junction/core` import in any client-reachable module; data flows only through `src/server/*.functions.ts` / `*.server.ts`. Native deps (`better-sqlite3`, `@napi-rs/keyring`, `@junction/core`) **must not** enter the client bundle. The CI leak-grep (Phase D) enforces this; `vite.config.ts` `ssr.external` already lists them — keep it.
2. **Credentials remain metadata-only in the UI.** Never render `secret`/`secretRef`. (The data layer already strips them; don't add a path that reintroduces them.)
3. **Every design value comes from a token** defined in DESIGN.md. No magic hex/px/ms in components. Tailwind theme = the single mapping from DESIGN.md → CSS vars → utilities.
4. **a11y is a gate:** WCAG AA contrast on every token pair, full keyboard nav, visible **amber** focus rings, ARIA via Radix (don't regress it), labelled controls, `prefers-reduced-motion` honored everywhere, **no color-only state** (badges pair color + dot + text).
5. **Departure Mono is wordmark-only** (display face; never body/eyebrows/tables/<14px). Everything else is Geist. (DESIGN.md discipline rule.)
6. **One accent.** Signal Amber owns interaction; status hues own state; **info is teal, never blue.**
7. **`pnpm verify` stays green** (now includes web typecheck + the new component tests) and the package-boundary rules (`depcruise`) still pass: web imports `core` only, no cli↔web edge.

## 3. Stack decisions (decided — don't re-litigate)

- **Tailwind v4** (CSS-first `@theme`, the current shadcn target) + **Radix primitives** + **cva** (class-variance-authority) + **tailwind-merge**/**clsx**. Components copied into `src/ui/` (owned, not a black-box dep).
- **Fonts self-hosted:** `geist` npm package (Sans+Mono). **Departure Mono**: vendor the OFL `.woff2` + license into `src/styles/fonts/` (not on npm). No runtime CDN.
- **Motion:** `sonner`, `vaul`, `motion` (`motion/react`), native View Transitions. (sonner/vaul/motion are installed now but only *wired where read-only allows* — toasts have nothing to fire yet; install + a tokenized `<Toaster/>` mounted, real usage inc 24+.)
- **Component tests:** **Vitest + happy-dom + @testing-library/react + @testing-library/jest-dom + @testing-library/user-event**, via a web-scoped Vitest project (the root `vitest.config.ts` is Node-env; web needs a `happy-dom` env without breaking the Node tests — use a separate `packages/web/vitest.config.ts` with `environment: "happy-dom"`).
- **Biome React domain:** enable `useExhaustiveDependencies` + the React/a11y recommended rules in `biome.json` (or a web-scoped override) so hooks + a11y violations fail the lint gate. (React Compiler is already on via babel — keep it; don't add eslint-plugin-react-hooks, Biome covers it.)

> **New-package check:** all of the above are libraries added to `@junction/web`'s `package.json`, not new workspace packages. No new package. Confirm each is ESM, actively maintained, and pinned per the existing range style.

## 4. Phasing (four phases; QA + commit between each)

Land as one PR but build/verify in this order so a break is localized.

### Phase A — Tokens + type + theme foundation
- Add deps: `tailwindcss@4` + `@tailwindcss/vite`, `geist`, `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/*` (only the primitives the inventory needs — see Phase B), `lucide-react` (icon set — neutral line icons, **not** emoji; ships with shadcn).
- Vendor Departure Mono `.woff2` + `OFL.txt` → `src/styles/fonts/`.
- Wire Tailwind v4 into `vite.config.ts` (`@tailwindcss/vite` plugin — **order matters**: keep `tanstackStart()` first, then the tailwind plugin, then `viteReact()`; verify SSR still externals core).
- Replace `src/styles/app.css` with `app.css` that: imports Tailwind, `@font-face`s Geist (from the `geist` package) + Departure Mono, and declares the **full token set from DESIGN.md** as CSS custom properties under `:root` (light) + `[data-theme="dark"]` / `@media (prefers-color-scheme: dark)`, then maps them in a Tailwind `@theme` block (colors, radius, spacing, font families, motion durations/easings). System-aware + a `data-theme` manual override hook.
- **Proof:** `pnpm --filter @junction/web build` succeeds; the existing routes render with Geist + tokens (still old markup, new theme); light/dark both resolve.

### Phase B — `ui/` primitive layer + badge taxonomy
- Build the owned primitives in `src/ui/` (shadcn pattern, cva variants, tokens only): **button, badge (status pill), card, table, separator, kbd, skeleton, tooltip, dropdown-menu, dialog, tabs**, plus a `cn()` util (clsx+tailwind-merge) and a `<Wordmark/>` component (Departure Mono + amber node; the **only** place that font is used).
  - Defer **input/field, sheet/drawer (vaul), copy-to-clipboard, toast wiring** real usage to inc 24+ (no write path yet) — but **scaffold** `<Toaster/>` (sonner, tokenized) mounted in `__root.tsx`, and the `field`/`input` primitives if cheap, so 24 is plug-in. State that choice in the report.
- **Status badge** implements the DESIGN.md taxonomy exactly (CONNECTED/NO AUTH/EXPIRING/AUTH FAILED/DISABLED → ok/info/warning/error/disabled tokens), color+dot+text, a `variant` prop, AA-checked both modes.
- **empty / loading (skeleton) / error** states as first-class shared components (the routes use them).
- The **status rail**: a `<StatusRail/>` shell component (static colored segments driven by source/credential state; reduced-motion safe; **no pulse**), mounted in the app shell.
- Each primitive ships a colocated `*.test.tsx` (happy-dom + Testing Library): behavior + a11y affordance (role/name, keyboard where relevant) + renders in dark (set `data-theme`).
- **Proof:** primitives render in isolation via tests; `pnpm --filter @junction/web test` green.

### Phase C — Re-skin the four routes + app shell with motion + a11y
- `__root.tsx`: new nav (Departure-Mono `<Wordmark/>`, Geist nav links, active = amber), the `<StatusRail/>` on the left edge, `<Toaster/>` mounted, theme toggle, the SVG favicon updated to the amber-node mark. Keep the inline-favicon approach (serve.mjs serves no static files — inc-22 gotcha).
- Re-skin `/` (stat cards + status dl → cards + a definition grid), `/credentials` (table + CONNECTED/-style badges from the real `kind`/state), `/platforms`, `/profiles` (profile cards + per-source table + namespace mono + enabled→badge), and `not-found.tsx` — using only `ui/` primitives + tokens. Same loaders/server fns; **only presentation changes.**
- Motion: route/tab transitions via View Transitions (gated), entrance/presence via `motion` where it earns it, all reduced-motion-safe. Fast (DESIGN.md durations).
- a11y pass: keyboard-walk every route, visible amber focus rings, labelled landmarks, badges never color-only.
- Each route keeps/gains a behavior test (renders the loader data shape; empty + populated states; a11y landmark present).
- **Proof:** all four routes + 404 re-skinned, light+dark, keyboard-navigable; tests green.

### Phase D — Quality scaffolding (rules + reviewer + CI)
- **`docs/rules/web.md`** — the enforceable web ruleset: server-only-core boundary (the leak-grep), tokens-not-magic-values, Departure-Mono-wordmark-only, one-accent / info-is-teal, a11y gates (AA, keyboard, focus, reduced-motion, no color-only), no-business-logic-in-components, `ui/`↔feature↔route layering, every component has a happy-dom+TL test in light+dark. Add it to the `docs/rules/README.md` table.
- **`junction-web-reviewer`** agent (`.claude/agents/…`, modeled on the existing `junction-*` reviewers) — reviews web diffs against `docs/rules/web.md` + DESIGN.md: token adherence, a11y, the boundary, the font discipline, anti-slop. Register it where the other junction agents are listed (and note it in `CLAUDE.md`'s reviewer map + `docs/workflow.md`).
- **CI web gate:** add a `web` job (or steps in `verify`) to `.github/workflows/ci.yml`: `pnpm --filter @junction/web build` then a **client-bundle leak-grep** — assert the built client output (`.output`/`dist` client chunks) contains **no** `better-sqlite3` / `@napi-rs/keyring` / `@junction/core` server-only identifiers. Fail the build if found. (This is the machine check for invariant #1.)
- **Biome React/hooks + a11y rules** enabled (Phase A's `biome.json` change verified to actually fire on a deliberately-broken hook dep during QA).
- **Proof:** `pnpm verify` green; new CI job green on the PR; the leak-grep demonstrably fails when a `@junction/core` import is added to a client module (test it locally, then revert).

## 5. Proof-of-done (the increment is done when ALL hold)

- [ ] `pnpm verify` green (typecheck + Biome incl. React rules + Vitest incl. new web component tests) on Node 20 + 22.
- [ ] `pnpm --filter @junction/web build` green; **leak-grep finds zero** server-only identifiers in the client bundle; CI web job green.
- [ ] `depcruise` green — web→core only, no cli↔web edge, no core→web.
- [ ] All four routes + 404 re-skinned to DESIGN.md, render correctly in **light and dark**, keyboard-navigable with visible amber focus rings, badges pair color+dot+text.
- [ ] `src/ui/` primitives exist, each token-driven with a happy-dom+TL test; `<Wordmark/>` is the only Departure-Mono user; `<StatusRail/>` static, reduced-motion safe.
- [ ] `docs/rules/web.md` + `junction-web-reviewer` exist and are wired into the rules table / reviewer map / workflow.
- [ ] No `@junction/core` change; no write path; credentials still metadata-only.
- [ ] DESIGN.md decisions log unchanged (this increment implements it; if a value provably can't work, surface to the orchestrator — don't silently deviate).

## 6. Reviewers to run (step 6 gate)

Always: **`junction-package-boundary`** (the boundary + leak-grep are the highest-risk surface), **`junction-clean-code-reviewer`**, and the new **`junction-web-reviewer`** (dogfood it on its own increment). Plus CE: **`ce-correctness-reviewer`**, **`ce-maintainability-reviewer`**, **`ce-testing-reviewer`**, and **`ce-security-reviewer`** (the client-bundle boundary is a real exfil surface — verify the leak-grep can't be fooled by code-splitting/dynamic import). Design-side: **`impeccable:critique`** (UX scoring) + **`design-review`** / **emilkowalski `review-animations`** (motion smoothness, reduced-motion) + browser dogfooding (gstack `browse`: screenshots light/dark, before/after, responsive). Skip perf/data/migration reviewers (no hot path, no schema change).

## 7. User test gate (step 7)

Visually testable: **yes.** After build:
```
JUNCTION_HOME=/tmp/jt23 ./junction credential add … # seed a couple sources (or reuse the repo-local .junction)
pnpm --filter @junction/web build
./junction web            # opens the re-skinned dashboard on localhost
```
User checks: instrument-grade look (not slop), Signal-Amber accent, the left-edge status rail, Departure-Mono wordmark, light/dark toggle + system-aware, keyboard nav + amber focus, badges legible in both modes, motion fast + reduced-motion respected.

## 8. Builder report-back (what to hand the orchestrator)

Exactly: (a) what shipped per phase + what was deferred to 24+ (toast/input/sheet real usage) with reasons; (b) `pnpm verify` + `build` + leak-grep output (paste the proof the leak-grep fails on a planted core import, then passes after revert); (c) any DESIGN.md value that fought reality + how resolved (or escalated); (d) new deps added + why each; (e) the three-part end-of-increment report (visually-testable / QA-I-verified / intricate-details checklist).

## 9. Futures to record (`docs/futures/`) — builder appends as it goes
- **`revisit-when.md`:** the **live rail pulse + patch-bay diagram** on the profile view — trigger: mutation/live-event surfaces exist (inc 26+). The static rail is the v1 stand-in.
- **`gotchas.md`:** Tailwind v4 + TanStack-Start Vite plugin ordering; the client-bundle leak-grep must account for code-splitting/dynamic-import (don't only grep the entry chunk); Departure-Mono self-host (not on npm — vendored, OFL license must ship).
- **`deprecations.md`:** none expected; note if any added dep carries an EOL risk.

---

# Addendum — Phase E: sidebar shell + stability + structural primitives

> Added 2026-06-28 after a foundation re-review (user-requested). The first build
> (Phases A–D, merged-ready) shipped a top-nav shell; review + live QA + design/
> routing research found the layout base isn't right for a data-management app and
> the app visually "shakes" on navigation. **Decision: fold this into inc 23 (don't
> merge yet), foundation-complete scope** — so feature increments (24+) assemble on
> a correct base instead of scaffolding it. Build on the SAME branch
> `feat/web-foundation-design-system`. DESIGN.md is updated (Layout, Icon discipline,
> Routing & data stability sections) — build FROM it.

## E.0 Why (root causes, already diagnosed against the built app — don't re-litigate)
- **Shake = two causes:** (1) `scrollbar-gutter: auto` + a **centered `mx-auto max-w-4xl`** content column → scrollbar toggling between short/tall pages changes viewport width and re-centers the column (horizontal jump); (2) View Transitions *amplify* that shift by animating it.
- **Unnecessary refetches:** every route has a bare `loader` with **no `staleTime`/no preload** → refetch on every revisit, no hover preload.
- **Foundation gaps:** no sidebar/page-header/toolbar primitives; no form inputs (24+ needs them); table lacks sticky header + row-action column; skeletons don't match loaded dimensions; no layout/z-index tokens; active-nav uses amber *text* (shouts).

## E.1 Scope (foundation-complete)
1. **Stability fixes** (small, high-impact, do first):
   - `app.css`: `scrollbar-gutter: stable` on `html`.
   - `router.tsx`: add `defaultPreload: "intent"`, `defaultStaleTime: 30_000`, and explicit `defaultPreloadStaleTime: 30_000`, `defaultGcTime: 1_800_000`, `defaultPendingMs: 1000`, `defaultPendingMinMs: 500`. Keep `scrollRestoration` + `defaultViewTransition`.
2. **Sidebar shell** (replace top-nav as primary nav):
   - New `src/ui/sidebar.tsx` (owned, shadcn *pattern* — Provider + cookie persistence + `Cmd/Ctrl+B` + `icon` collapsible + tooltip-on-collapse — skinned with OUR tokens, not shadcn's zinc theme).
   - `__root.tsx`: fixed five-zone shell (StatusRail · Sidebar · Topbar · PageHeader slot · Content). Sidebar header = `<Wordmark/>` (collapsed → amber node only); content = grouped nav (`MANAGE`/`CONNECT`) with eyebrow-caps group labels; footer = theme toggle + a textual status summary + `⌘B` hint (via `kbd.tsx`).
   - **Active state:** neutral `--fg` + `--surface-2` bg + `inset 2px 0 0 var(--accent)` left bar (NOT amber text). Icon may be `--accent`.
   - **Collapse persistence:** cookie (e.g. `junction-sidebar`), read **server-side** for SSR + an inline pre-hydration set (mirror `THEME_SCRIPT`) so width is correct before hydration — no flash. Toggle on `Cmd/Ctrl+B`.
   - Keep the skip-link as the first focusable element; keep `StatusRail` fixed, `TooltipProvider`, `Toaster`, the theme script.
3. **Topbar** = thin context bar: section/breadcrumb (left) + global slot (right). (Full breadcrumb deferred to detail pages — futures note.)
4. **`PageHeader` component** (`src/ui/page-header.tsx`): title (`--text-page-title`) + count chip (a muted `Badge`) + optional subtitle + an `actions` slot (right). Used by all four list routes (rule-of-four satisfied → DRY now). Reserve its height during load.
5. **Table upgrades** (`table.tsx`): sticky `<thead>` (`position: sticky; top:0`, `--surface` bg + bottom border), a trailing right-aligned **actions column** convention (a `⋯` `dropdown-menu` trigger, revealed on row hover/focus but keyboard-reachable), and `aria-sort` hooks for sortable headers. (Wiring real sort/actions to data is fine to stub where there's no write path yet — but the column + a11y scaffolding lands now.)
6. **Skeletons** (`skeleton.tsx` / a `TableSkeleton`): render N rows at exactly `--row-height-data` with matching column widths; used as the route `pendingComponent` or loading branch so there's zero reflow.
7. **Form primitives** (for inc 24+, build now): `input.tsx`, `field.tsx` (label + control + inline error/description, a11y-wired), `select.tsx` (`@radix-ui/react-select`), `switch.tsx` (`@radix-ui/react-switch`), `checkbox.tsx` (`@radix-ui/react-checkbox`). Token-driven, cva variants, each with a happy-dom + TL test (incl. label association + error announce).
8. **Layout tokens** in `app.css`: `--sidebar-width: 15rem`, `--sidebar-width-icon: 3rem`, `--topbar-height` (≈44px, reuse the h-11 value), `--content-max` (≈1280–1400px upper bound), and a small **z-index scale** (`--z-rail`, `--z-sidebar`, `--z-topbar`, `--z-overlay`) replacing the ad-hoc `z-30/z-40/z-50`.
9. **Altitude fix:** the dashboard stat-card grid reads as the AI-slop "hero-metric template." Keep cards for the dashboard summary but make it feel designed (vary, don't 3-up identical tiles); tables stay for the record lists. Light touch — don't gold-plate.
10. **Re-skin the 4 routes + 404** to use `PageHeader` + the stable content zone. Same loaders/server-fns (add `staleTime` via router default, no per-route change needed). Replace inline `<code>`/title duplication with the shared components.

## E.2 Hard invariants (unchanged from Phase A–D + additions)
- All Phase-A–D invariants still hold (server-only-core boundary + leak-grep, credentials metadata-only, tokens-not-magic-values, WCAG-AA, Departure-Mono wordmark-only, one accent / info-teal, depcruise clean).
- **New:** every icon-only control has tooltip + `aria-label` + `aria-hidden` icon (per DESIGN.md Icon discipline). Sidebar collapse must be **SSR-correct (cookie, no flash)** — a `useEffect`/localStorage-only read that flashes the wrong width is a fail (same class as the theme flash we already prevent). No layout shift on navigation (verify with a real dashboard↔credentials nav).
- Still **read-only** — no mutations. Form primitives are built + tested in isolation; they are NOT wired to write paths this increment. The table actions column + sort are scaffolded (a11y + structure) but may be visually-present/no-op until inc 24+ data exists — state which in the report.

## E.3 Proof-of-done (additions)
- [ ] `pnpm verify` green (incl. new primitive + sidebar tests); web build + leak-grep + depcruise green.
- [ ] **No shake:** driving a real dashboard↔credentials↔profiles nav shows zero horizontal/vertical content shift (verify in a browser; `scrollbar-gutter: stable` + left-aligned shell + matched skeletons). Reduced-motion still respected.
- [ ] **No bounce-refetch:** dashboard→credentials→dashboard within 30s does NOT re-run `getDashboard` (network panel); nav links preload on hover.
- [ ] Sidebar: grouped nav, collapsible via `Cmd+B`, collapse **persists across reload with no flash** (cookie + SSR), icon-only-when-collapsed has tooltips, active state is the 2px amber bar (not amber text).
- [ ] `PageHeader` used by all 4 routes; table has sticky header + actions-column scaffold; form primitives exist + tested.
- [ ] Layout + z-index tokens in app.css; no ad-hoc z-values left in components.

## E.4 Reviewers (re-run the relevant lenses on the Phase-E delta)
`junction-web-reviewer` + `junction-package-boundary` (boundary unchanged but new deps + shell) + `ce-correctness` (router caching/preload + cookie SSR hydration — watch for hydration mismatch on the sidebar width) + `ce-security` (the new cookie read + any new client surface) + `impeccable:critique` / `design-review` / emil `review-animations` (the new shell, active state, motion) + browser dogfooding (sidebar collapse, shake-gone, both themes, keyboard).

## E.5 Builder report-back
Per the standard report + specifically: paste the network-panel proof (no bounce-refetch + hover-preload), a before/after on the shake (a short note on the dashboard↔credentials nav being stable), the SSR-no-flash proof for sidebar collapse, new deps + why, and what's scaffolded-but-not-wired (table actions/sort, form primitives) deferred to inc 24.
