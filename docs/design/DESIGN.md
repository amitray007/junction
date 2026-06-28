# Design System — Junction Web (`@junction/web`)

> The **decided** design system for the Junction web dashboard. The intent + process
> live in [`web-ui-brief.md`](./web-ui-brief.md); **this file is the decisions** —
> tokens, type, color, spacing, motion, the component inventory, the badge taxonomy.
> Components reference tokens; **no magic values**. Read this before any web UI work.
>
> _Decided 2026-06-28 via the design consultation (Codex + two independent design
> passes converged; open taste calls resolved with the user). Increment 23 implements it._

---

## Product context

- **What:** the management surface for Junction — a self-hosted, single-user **localhost broker**. You connect platform accounts once; AI agents reach them via MCP/CLI/API.
- **Who:** one technical power user, on `localhost`. Not a marketing site, not multi-tenant.
- **Type:** dense **management dashboard / instrument** (read-only today: credentials, platforms, profiles, per-profile MCP source status; mutation surfaces land inc 24+).
- **Quality bar:** shadcn/ui · Vercel dashboard · Linear · Geist design language.

## The memorable thing (north star)

**"This thing is precise."** The first-3-seconds reaction is *trust through exactness* — the quiet authority of an instrument (a patch bay, an oscilloscope), not an app that markets to you. Cool charcoal panel, **one amber signal line that's actually alive.** Every decision below serves that. No delight-bait; the thrill is recognition.

## Anti-slop guardrails (hard)

No purple/blue gradients · no centered hero · no emoji-as-iconography · no drop-shadow soup (separation is **1px borders**, not shadows) · no five competing accents (**one** chromatic accent) · no `system-ui` as the display/body face · no bubble-radius-everything · no inconsistent spacing. Every color/badge/radius/transition traces to a token here.

---

## Aesthetic direction

- **Direction:** minimalistic, shadcn-like, **instrument-grade**. Industrial/utilitarian restraint with one warm signal accent.
- **Decoration level:** minimal — type, 1px borders, and the single accent do the work.
- **Mood:** calm, dense, fast, a little severe. A machine you operate.
- **The thesis made visible:** Junction is a switchboard. The signature element (below) shows the routes lighting up, because the product is a router.

---

## Typography

Self-host via the `geist` npm package (no runtime CDN). Departure Mono is self-hosted from its OFL release (not on npm — vendor the `.woff2`).

- **UI / body:** **Geist Sans** — all interface text, prose, labels, form fields.
- **Mono / data:** **Geist Mono** — IDs, endpoints, namespaces (`github__list_prs`), counts, kbd hints, table cells that hold identifiers. Tabular figures on for numeric columns.
- **Eyebrows / section labels:** **Geist Mono, uppercase, `letter-spacing: 0.08em`, 11px, muted** — the "rack-label" voice. Used everywhere a section needs a quiet machine-readout label.
- **Wordmark — DECIDED (Option B):** **Departure Mono** (free, OFL, pixel-grid) for the **wordmark only** — "JUNCTION" with a small **amber square node** as the patch-point glyph beside it. The one pixel hit, load-bearing, where the instrument character lives.
  - **Discipline rule (enforced by review):** Departure Mono is a **display** face — **never** body, **never** eyebrows, **never** tabular data, **never** below ~14px. Wordmark only. Everything else is Geist.

### Type scale (px)

| Role | Token | Size | Weight | Notes |
|---|---|---|---|---|
| Page title | `--text-page-title` | 20 | 600 | tracking `--tracking-tight` (`-0.01em`) |
| Section heading | `--text-section` | 15 | 600 | |
| Body / table cell | `--text-body` | 13 | 400 | line-height 1.5 — the power-tool register (sub-14 base) |
| Mono / IDs | `--text-mono` | 12.5 | 400/500 | Geist Mono, tabular for numbers |
| Eyebrow / label | `--text-eyebrow` | 11 | 500 | Geist Mono, uppercase, tracking `--tracking-eyebrow` (`0.08em`) |
| Stat count | `--text-stat` | 28 | 700 | Geist Mono, dashboard stat cards; tabular-nums |
| Hero / 404 | `--text-hero` | 64 | 700 | Geist Mono, large muted decorative numbers only |

**Tracking tokens:** `--tracking-tight: -0.01em` (page titles) · `--tracking-eyebrow: 0.08em` (eyebrow labels).

---

## Color

**One chromatic accent (Signal Amber) owns *interaction*; status hues own *state*.** Amber = "a line is live, carrying signal" — the switchboard metaphor. Cool zinc neutrals make the warm accent ignite. Light + dark, system-aware (`prefers-color-scheme`), with a manual toggle.

### Accent — Signal Amber
| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | `#B45309` | `#F59E0B` | accent text/border/focus ring (AA on surface) |
| `--accent-fill` | `#D97706` | `#FBBF24` | primary-action fill, live rail segment |
| `--accent-fg` | `#FFFFFF` | `#1A1206` | text on an accent fill |

Used for: active nav, focus rings, primary action, the live status rail. **Nothing else gets accent.**

### Neutrals — zinc (cool)
| Token | Light | Dark |
|---|---|---|
| `--bg` | `#FFFFFF` | `#09090B` |
| `--surface` | `#FAFAFA` | `#18181B` |
| `--surface-2` | `#F4F4F5` | `#202023` |
| `--border` | `#E4E4E7` | `#27272A` |
| `--fg` | `#18181B` | `#FAFAFA` |
| `--muted` | `#71717A` | `#A1A1AA` |

Dark is **true near-black** (`#09090B`), not navy. Max two surface levels; depth is borders, not shadows.

### Status — DECIDED (info = teal, no blue)
| State | Light text | Dark text | Light tint bg | Dark tint bg |
|---|---|---|---|---|
| ok / connected | `#15803D` | `#4ADE80` | `#F0FDF4` | `#052E16` |
| warning | `#A16207` | `#FACC15` | `#FEFCE8` | `#1C1407` |
| error | `#B91C1C` | `#F87171` | `#FEF2F2` | `#2A0A0A` |
| info | `#0E7490` | `#22D3EE` | `#ECFEFF` | `#0B2230` |
| disabled | `#A1A1AA` | `#52525B` | (transparent, border only) | |

**Info is teal, not blue** — strict anti-slop (blue is the AI default). Status colors are text/icon/dot + a faint tint only — **never** saturated fills. **Connected-green (≈140°)** and **accent-amber (≈35°)** are far enough apart to never read as the same state.

**a11y:** every status foreground clears WCAG AA (≥4.5:1) on its bg/tint. Never color-only — always paired with a dot **and** text/icon (see badges).

---

## Spacing & density

- **Base unit: 4px.** Scale: 4 · 8 · 12 · 16 · 24 · 32 · 48. No 6px/10px one-offs.
- **Density: compact** (it's an instrument; show 20 rows, not 8).
- **Table row: 36px** data / 40px header. Cell padding `8px 12px`.
- **Control height: 32px** (buttons/inputs/selects).
- **Page gutter: 24px** · card padding `16px`.

## Layout & geometry

- **Approach:** grid-disciplined app shell — top nav + the left-edge status rail + a max-width content column.
- **Radius:** `--radius-sm 0.25rem (4px)` inputs/badges/chips · `--radius-md 0.375rem (6px)` buttons/cards/popovers (the workhorse) · `--radius-lg 0.5rem (8px)` dialogs/sheets/panels. Full (`9999px`) **only** status dots & avatars. The amber wordmark node is deliberately `0` radius (the one sharp element).

---

## Motion

Emil-Kowalski school: **purposeful and fast**, confirms state change, never decorates. All transforms gated by `prefers-reduced-motion` → opacity-only at 100ms.

| Token | ms | Use |
|---|---|---|
| `--motion-micro` | 100 | hover, focus ring, dot color shift |
| `--motion-short` | 160 | dropdowns, popovers, tooltips, toasts, tabs |
| `--motion-medium` | 240 | dialogs, sheets, route/view transitions |

- **Easing:** enter/standard `cubic-bezier(0.16, 1, 0.3, 1)` (expo-out — fast start, soft landing) · exit `cubic-bezier(0.4, 0, 1, 1)` (faster out than in).
- **Libraries (lightest thing that feels great):**
  - **sonner** — toasts (mutation feedback once writes land, inc 24+). Mono detail line, no emoji.
  - **vaul** — bottom sheet for **narrow/mobile only**; on desktop use a Radix Dialog. Don't drawer everything.
  - **View Transitions API** — same-document route/tab changes (progressive enhancement + support check + reduced-motion gate).
  - **motion** (`motion/react`) — surgical: the rail pulse, list reorder, presence (`AnimatePresence`) on rows. Native first; reach for motion only where VT/CSS can't.

---

## Component inventory (foundation)

Owned in `packages/web/src/ui/` (shadcn pattern: Radix primitives + Tailwind + cva variants, copied not black-boxed; a11y comes from Radix and we don't regress it).

button · input/field (+ inline validation) · card · **badge / status pill** · table (sortable, empty/loading) · dialog · sheet/drawer (vaul narrow) · dropdown menu · tabs · tooltip · toast (sonner) · skeleton · separator · kbd · copy-to-clipboard. Plus **empty / loading / error states as first-class** (the dashboard has many).

## Status-badge taxonomy (DECIDED)

The semantic mapping every credential/platform/profile/source state renders through. Color **always** paired with a dot + text (a11y). Tokens from the status table above.

| Badge | Token | Meaning (where used) |
|---|---|---|
| **CONFIGURED** | configured (neutral: `--muted` on `--surface-2`) | credential stored but **not live-validated** yet (all creds in inc 23–27; probe lands inc 28) |
| **CONNECTED** | ok | credential valid · source live · platform reachable (reserved for live-probe result, inc 28+) |
| **NO AUTH** | info | public / no-auth source (optional-credential sources, inc 16) |
| **EXPIRING** | warning | token near expiry / degraded (OAuth, inc 28) |
| **AUTH FAILED** | error | credential invalid / source unreachable |
| **DISABLED** | disabled | profile source toggled off · credential unused |

**Note on CONFIGURED vs CONNECTED:** CONNECTED asserts liveness ("credential valid AND source reachable"). Until inc 28 adds live health probing, all stored credentials show CONFIGURED — a neutral state that says "this credential was added successfully" without overstating. The `configured` cva variant uses `--muted` text on `--surface-2` bg (same as `disabled` surface but with `--muted` rather than `--status-disabled-fg`).

## The ONE memorable detail — the live status rail (DECIDED)

A persistent **4px vertical rail down the far-left edge** = the literal junction. Each connected source is a short segment whose **color is its state** (live = amber, ok = green, warning, error, idle/disabled = neutral). When an agent hits a source via MCP, that segment does a single **160ms amber pulse** — signal passing through a contact. Calm when idle, alive when traffic flows.

- **Inc 23 ships the static rail** (colored segments, no live pulse — there's no live-event source yet). It reads as the signature element on its own.
- **The pulse + the fuller patch-bay diagram are recorded in `docs/futures/`** to wire in once mutation/live-event surfaces exist (inc 26+).
- Buildable as a flex column of `div`s driven by status; reduced-motion → brief opacity tick, never a transform.

---

## Clean-code patterns (web)

- **No business logic in components** — logic stays in `@junction/core`; components render + call `createServerFn`. The server-only-core boundary (inc 22) is preserved: native deps never reach the client bundle.
- **Layers:** `ui/` primitives → feature components → route files. Composition over configuration. Tokens + cva variants over one-off styles.
- Every component ships a **happy-dom + Testing Library** test (behavior + a11y affordances) and renders in light **and** dark.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-28 | Accent = Signal Amber (`#B45309`/`#F59E0B`) | switchboard "live signal" identity; anti-blue/violet; one accent only |
| 2026-06-28 | Neutrals = cool zinc; true near-black dark | makes warm accent pop; instrument register; borders not shadows |
| 2026-06-28 | Info hue = **teal** (not blue) | strict anti-slop; blue quarantined out entirely (confirmed visually by user) |
| 2026-06-28 | Wordmark = **Departure Mono pixel face (Option B)**, wordmark-only | strongest instrument character; one load-bearing pixel hit (user chose B over the `junction__` cursor) |
| 2026-06-28 | Density compact, 4px grid, 36px rows, 32px controls, 13px body | power-tool scan density |
| 2026-06-28 | Radius 4/6/8 (md=6 default) | precise, not consumer-pill |
| 2026-06-28 | Motion 100/160/240ms, expo-out; sonner + vaul(narrow) + View Transitions + motion | Emil-grade, fast, reduced-motion-safe; lightest stack |
| 2026-06-28 | Signature = left-edge live status rail (static v1, pulse later) | product thesis as one visible detail; cheap, global, distinctive |
