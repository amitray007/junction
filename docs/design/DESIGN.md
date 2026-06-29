# Design System — Junction Web (`@junction/web`)

> The **decided** design system for the Junction web dashboard, rewritten for inc 24.5.
> Components reference tokens; **no magic values**. Read this before any web UI work.
>
> _Decided 2026-06-29. **Replaces the inc-23 "instrument" system** (amber/zinc/Departure-Mono, the live
> rail). Grounded in the Vercel **Geist** design language (design.md / guidelines / dark tokens),
> adapted for a single-user localhost broker, and authored against the anti-slop reference in
> `docs/design/anti-ai-slop.md` + the impeccable.style/slop checklist. The full design rationale, the
> domain model it serves, and the prior-art exploration live in `docs/design/24.5-ux-foundation-notes.md`._
> _The previous (inc-23) version of this file is preserved in git history (pre-24.5)._

---

## Product context

- **What:** the management surface for Junction — a self-hosted, single-user **localhost broker**. You connect platform accounts once; AI agents reach them via one MCP endpoint, scoped by profile.
- **Who:** one technical user who wants it to feel **effortless** while staying **in control**. Not multi-tenant, not a marketing site.
- **Type:** a calm, high-contrast **product dashboard** (Geist register). Read-heavy today; mutation surfaces grow per increment.
- **Quality bar:** Vercel dashboard / Geist. Restrained minimalism, high contrast, whitespace, **color signals state — not decoration**.

## North star

**"Effortless and in control."** A person should be able to connect an account, group it into a profile, and point an agent at the endpoint without friction, while always seeing exactly how their data is routed. The memorable, junction-specific element is the **route row**: a connection's path (`source → account → namespace · filter → on/off`) read on one line.

## Anti-slop guardrails (hard — see `docs/design/anti-ai-slop.md`)

Every item is a MUST-NOT unless it traces to a documented decision below.
No side-accent border on cards/nav (the #1 tell). No hero-metric stat banner. No identical card grids, no nested cards. No mono-eyebrows/section-kickers everywhere. No dark-mode-with-glow, no purple/violet/cyan, no cream/beige page. No gradient text. Body **≥14px**. No em-dash overuse in copy, no "theater"/aphoristic tics, no marketing buzzwords. Status is **text + dot**, never color alone.

**Documented, deliberate exceptions** (would otherwise read as tells):
- **Geist Sans/Mono** is used despite being on the "overused" list. This is a deliberate choice: the project's quality bar is explicitly Geist, and Geist Sans is a genuinely well-cut neutral face. (Decision log below.)
- **Blue accent.** The generic checklist says "avoid blue." Geist's signature accent is blue, and we adopt it as the single state/action accent. Deliberate. (Decision log.)
- **Subtle shadows for elevation** (Geist uses two-layer ambient+direct shadows). This reverses inc-23's "borders not shadows." Deliberate.

---

## Typography

Self-hosted: the Geist Sans/Mono variable `.woff2` are **vendored raw** in `packages/web/src/styles/fonts/`
(no `geist` npm dependency, no runtime CDN). Do not add a `geist` package.

- **Sans — Geist Sans:** all UI text, headings, labels, body. Two weights per view max (400/450 text, 500/600 emphasis).
- **Mono — Geist Mono:** IDs, endpoint URLs, namespaces (`gh`, `github__list_prs`), tool-filter expressions, counts in tables, config blocks. `font-variant-numeric: tabular-nums`. Mono is for **data that is literally an identifier/number** — never as decorative eyebrows.

No display/serif face. Hierarchy comes from size, weight, and space.

### Type scale (Geist token model; px)

| Role | Token | px | weight | line-height | use |
|---|---|---|---|---|---|
| Page title | `--text-h1` | 24 | 600 | 1.25 | one per page |
| Section | `--text-h2` | 15 | 600 | 1.4 | section headings |
| Subsection | `--text-h3` | 14 | 600 | 1.4 | card headers |
| Body / cell | `--text-body` | 14 | 400 | 1.6 | the floor — never below |
| Label | `--text-label` | 13 | 450/500 | 1.4 | nav, metadata, single-line |
| Caption | `--text-caption` | 12 | 400 | 1.5 | secondary metadata |
| Mono / data | `--text-mono` | 13 | 400/500 | 1.5 | Geist Mono, tabular |
| Stat | `--text-stat` | 22 | 600 | 1.2 | at-a-glance counts (a small row, not a banner) |

Title Case for labels, buttons, tabs, titles. Sentence case for body and helper text.

---

## Color

**Geist numbered-intent model.** Each scale runs steps that encode *intent*, not lightness: 100–300 backgrounds, 400–600 borders, 700–800 fills, 900–1000 text. **Gray ranks information** (1000 primary, 900 secondary, 700 disabled). **One accent (blue)** carries state + the single most important action. Light + dark are equal, same token names.

### Neutrals

| Token | Light | Dark |
|---|---|---|
| `--bg-100` (page, cards) | `#FFFFFF` | `#000000` |
| `--bg-200` (subtle separation only) | `#FAFAFA` | `#0A0A0A` |
| `--gray-100` (hover fill) | `#F2F2F2` | `#1A1A1A` |
| `--gray-400` (strong border) | `#CFCFCF` | `#454545` |
| `--gray-600` (faint text / off-state) | `#8F8F8F` | `#8F8F8F` |
| `--gray-700` (disabled text) | `#6F6F6F` | `#7A7A7A` |
| `--gray-900` (secondary text) | `#525252` | `#A0A0A0` |
| `--gray-1000` (primary text) | `#171717` | `#EDEDED` |
| `--alpha-200` (divider) | `rgba(0,0,0,.05)` | `rgba(255,255,255,.06)` |
| `--alpha-400` (border) | `rgba(0,0,0,.08)` | `rgba(255,255,255,.10)` |

Dark page is **true black `#000`** (Geist), light is true white. Borders/dividers use the alpha scale so they layer correctly. (`--bg-200` is for subtle separation only — never a general fill.)

### Accent — Blue (state + the one primary action)

| Token | Light | Dark | use |
|---|---|---|---|
| `--blue-700` | `#0072F5` | `#3B9EFF` | focus ring, links |
| `--blue-text` | `#0068D6` | `#6CB6FF` | namespace chips, the endpoint, syntax keys |
| `--blue-bg` | `#F0F7FF` | `#0F1B2D` | namespace/endpoint chip background |

**Note:** the *single most important action per view* is the Geist primary button = **solid `--gray-1000` fill** (not blue). Blue is reserved for **state, links, focus, and the endpoint/namespace identity**. This keeps the accent budget tight.

### Status (text + dot, never color-only; WCAG AA)

Each state is a **named token** in `app.css` (tokens-only is a hard rule — components reference the token,
never the hex). Light / dark values:

| State | Token | Light | Dark | meaning |
|---|---|---|---|---|
| configured | `--status-configured-fg` | `--gray-700` | `--gray-900` | stored, not live-probed (inc 23–27 default) |
| connected / ok | `--status-ok-fg` | `#1A7F37` | `#62C073` | live (reserved, probe inc 28+) |
| no auth | `--status-noauth-fg` | `--blue-text` | `--blue-text` | public source |
| warning | `--status-warning-fg` | `#A35200` | `#D99320` | expiring (OAuth, inc 28) |
| error | `--status-error-fg` | `#C9342A` | `#FF6166` | auth failed |
| off / disabled | `--status-off-fg` | `--gray-600` | `--gray-600` | route toggled off |

---

## Spacing & layout

- **4px base.** Scale: 4 · 8 · 12 · 16 · 24 · 32 · 40 · 64.
- **Three-step rhythm (Geist):** 8px inside a group · 16px between groups · 40px between sections. Varied, not monotonous.
- **Content width (inc 24.6):** left-aligned in the shell, **using the available width** up to `--content-max` ≈ **1216px** (76rem) with comfortable right padding — NOT a narrow column stranded in a wide viewport (that reads unfinished). `scrollbar-gutter: stable` (no shake). Only content scrolls. Left-aligned at a wide cap reads intentional; do not center a narrow column in dead space.
- **Card padding:** 20–24px. **Radii:** 6px controls/surfaces · 12px cards/menus · full only for pills/dots. One radius family per view.
- **Elevation (Geist two-layer; named tokens):** Child radius ≤ parent. Values:
  | Token | Light | Dark |
  |---|---|---|
  | `--shadow-sm` (raised card) | `0 1px 2px rgba(0,0,0,.04)` | `0 1px 2px rgba(0,0,0,.5)` |
  | `--shadow-md` (popover/menu/dialog) | `0 1px 1px rgba(0,0,0,.02), 0 4px 8px -4px rgba(0,0,0,.04), 0 16px 24px -8px rgba(0,0,0,.06)` | `0 1px 1px rgba(0,0,0,.3), 0 4px 8px -4px rgba(0,0,0,.5), 0 16px 24px -8px rgba(0,0,0,.6)` |

### App shell

- **Sidebar (~240px):** wordmark (the `J` glyph + "Junction" lockup) at top; plain-text destinations (Dashboard · Profiles · Platforms · Credentials) with right-aligned counts; gray-ranked, active = `--gray-100` bg + `--gray-1000` text (**no side-accent stripe**). Footer: running status + theme toggle.
- **Content:** page title row (title + the one primary action) → lede → sections. (No redundant breadcrumb that merely repeats the page title — inc 24.6.)
- No separate top control bar; the page title row carries the primary action.
- **Dashboard composition (inc 24.6):** a **two-column** layout that uses the width, not a flat equal-weight stack. **Connect an Agent is the primary block** (prominent, top / wider column — the focal point); **At a Glance** (the count strip) + **System** (store/sandbox/home, a quiet detail) sit alongside as secondary; **Recent Activity** is a quiet footer. The grid **collapses to one column** at narrow widths. Vary the section rhythm (8/16/40) — do not give every section the same gap or wrap each in an identical card.

---

## Components

- **Button hierarchy (Geist):** Primary = solid `--gray-1000` fill, `--bg-100` text (one per view). Secondary = `--bg-100` fill + `--alpha-400` border. Tertiary/ghost = transparent, `--gray-1000` text. Error = red fill, confirm step. Sizes 32/34/40. **Focus ring** = 2px surface gap + 2px `--blue-700` on every interactive element.
- **Card:** `--bg-100`, `--alpha-400` border, `--shadow-sm`, 12px radius. Header row (h3 + meta) + body. Never nested.
- **Table / list:** hairline-divided rows (`--alpha-200`), 14px body, ~44px row height, mono for identifiers, hover = `--gray-100`. Column headers in `--gray-700` 12px (not uppercase-mono). Row actions behind a trailing `⋯` (icon-only allowed for repeated row actions) with tooltip + aria-label.
- **Route row (signature):** `source → account → ns-chip · filter → on/off`. `→` separators in `--gray-400`, namespace in a `--blue-bg`/`--blue-text` chip, filter in mono `--gray-700`, status as dot+label. Reuse of one connection across profiles is legible because the path shape is shared and one segment differs.
- **Single-endpoint config block:** the one shared endpoint in mono + Copy; tabbed agent config (Claude / Cursor / Raw) as a mono code block (blue keys); a line showing "your key selects the profile" with key→profile chips (the keys are **Coming soon**).
- **Status badge:** dot + Title-Case label; tints faint; never color-only. Keeps the **Configured** taxonomy (stored, not live-probed) from inc 23.
- **`ComingSoon` affordance (NEW):** a small, quiet pill — `--gray-100` bg, `--gray-700` text, label "Coming soon" — placed on deferred actions/sections (disabled button + pill, or a section tag). Used wherever the backend isn't wired yet (recent activity, platform/profile mutations, key management). It must read as *intentional and honest*, not unfinished: pair the disabled control with a one-line hint pointing to the CLI where the action exists today (e.g. "Use `junction platform add` for now"). **(inc 24.6) The "coming soon" meaning comes from the pill + copy — NEVER from dimming the whole block with blanket `opacity`** (that reads as broken/loading). Illustrative content (e.g. the Connect-an-Agent endpoint/config preview) renders at **full contrast**, with non-copyable affordances (no Copy button, `user-select:none`/`pointer-events:none`) carrying the "not live yet" signal. **Consolidate** repeated ComingSoon chrome: one quiet "manage via CLI" affordance per card, not a pill + hint stacked for every deferred action.
- **Empty / loading / error states:** first-class. Empty = one plain line + the first action. Loading = skeletons that mirror final content (no layout shift). Error = what happened + how to fix.

## Motion

Geist timing: 0ms most · ~150ms state · ~200ms popover/tooltip/tab · ~300ms overlay/dialog. **Never `transition: all`** (list intended properties). transform/opacity only; honor `prefers-reduced-motion`. No bounce/elastic. Easing `cubic-bezier(0.16, 1, 0.3, 1)` for enters.

## Copy voice (Geist)

Active voice, second person, as few words as possible. Title Case for labels/buttons/titles; sentence case for body/helper. Verb + noun for actions ("Add Credential", not "OK"). "&" over "and". Numerals for counts. Curly quotes, ellipsis character. No "please", no marketing buzzwords, no em-dash overuse, no "theater"/aphoristic cadence. Errors: what happened + how to fix. Toasts name the thing changed, no trailing period, avoid "successfully". In-progress: "Rotating…".

---

## The 4 surfaces (v1 content + layout)

**Dashboard** (`status`/`init` data). Status line (running · store · sandbox) · **Connect an Agent** (the single endpoint + tabbed config + key→profile chips, keys = Coming soon) · At a Glance (counts as a small stat row, not a banner) · Recent Activity = **Coming soon** (needs audit, inc 29).

**Platforms** (`PlatformMeta[]`). Lighter re-skin: a ruled list — Name · Kind (mono tag) · Connections count · Detail; row → kind-specific descriptor + which profiles route it. `Add Platform` = **Coming soon** (inc 25).

**Credentials** (`CredentialMeta[]`). **Fully wired** (inc 24): grouped by platform (the wedge reads as multiple accounts under one source) — Platform · Account · Kind · Status · `⋯` (Rotate / Delete). `Add Credential` works. Secrets never shown. Delete-while-routed → blocked, names the profiles.

**Profiles** (`ProfileMeta[]`). Full read: each profile a card with its **route rows** (read-only) + "N keys active" (Coming soon). `New Profile` / `Add Route` / `Edit tool access` = **Coming soon** (inc 26). No per-profile endpoint URL (single-endpoint model).

---

## Clean-code patterns (web)

- No business logic in components; logic in `@junction/core`, components call `createServerFn`. Server-only-core boundary preserved (inc 22). Native deps never reach the client bundle.
- `ui/` primitives → feature components → routes. Tokens + cva variants over one-offs. Every component ships a happy-dom + Testing Library test and renders in light **and** dark.

## Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-29 | Rewrite to a Geist-grade system; retire the inc-23 instrument system | User set the bar at Vercel/Geist; prior system read slop-adjacent (side-accent bar, mono-eyebrows, 13px body, amber-glow) |
| 2026-06-29 | Keep **Geist Sans/Mono** (documented exception to "overused") | Deliberate: the quality bar is Geist; the face is genuinely well-cut |
| 2026-06-29 | **Blue** as the single state/accent (documented exception to "no blue") | Geist's signature accent; reserved for state/links/focus/endpoint identity |
| 2026-06-29 | Primary action = solid gray-1000 fill, not blue | Geist convention; keeps accent budget tight |
| 2026-06-29 | Subtle two-layer shadows for elevation (reverses inc-23 "borders not shadows") | Geist uses shadows; gives depth without the heavier inc-23 border look |
| 2026-06-29 | Dark + light equal, true black `#000` dark / true white light | Geist; both first-class |
| 2026-06-29 | Body floor 14px; 4px grid; 8/16/40 rhythm; radii 6/12 | Geist density + the anti-slop "≥14px / varied spacing" rules |
| 2026-06-29 | **Single shared MCP endpoint** model in the UI (no per-profile URLs); profile chosen by junction key | User decision; auth backend is a later increment, the v1 UI is shaped for it |
| 2026-06-29 | **"Coming soon"** affordance for deferred backends (with a CLI hint) | inc 24.5 is the setup/foundation increment; shows the whole shape truthfully without faking functionality |
| 2026-06-29 | Signature element = the **route row** (replaces the inc-23 live rail) | junction-specific structure (routing legible) instead of edge decoration |
| 2026-06-29 (24.6) | Content **uses the width** (≈1216px cap, left-aligned) — not a narrow column stranded in a wide viewport | impeccable:critique found the 960px column left a dead right half → read unfinished/templated |
| 2026-06-29 (24.6) | **Two-column Dashboard**: Connect-an-Agent primary, At-a-Glance + System secondary, Recent Activity footer | Flat equal-weight stack had no hierarchy; the most important block (Connect) didn't read as the point |
| 2026-06-29 (24.6) | ComingSoon signals via **pill + copy + non-copyable affordances, never blanket `opacity`** | The dimmed AgentConfig read as broken/loading, not "coming soon" — the worst look for the key surface |
| 2026-06-29 (24.6) | Drop always-empty columns (Platforms "Base URL"); consolidate repeated ComingSoon chrome | A column of `—` and 4 pill+hint clusters per card are noise; restraint over completeness |
