# Junction Web UI — Design Brief

> The durable design direction for `@junction/web`. Increment 23 builds the design
> system *from* this brief; the increment's output is `docs/design/DESIGN.md` (the
> decided system — tokens, type scale, palette, component inventory). This file is
> the **intent + constraints + process**; DESIGN.md is the **decisions**.

## Vision

A **minimalistic, distinctive, intentional** UI — **shadcn-like** in structure and
restraint, but with a point of view so it **stands out visually and never reads as
"AI slop."** Think the craft level of Vercel's dashboard, Linear, and shadcn/ui:
calm, precise, fast, confident. Single-user localhost tool — it should feel like a
well-made instrument, not a marketing page.

**Anti-slop guardrails (explicit):** no generic purple-blue gradients, no
everything-centered hero layouts, no emoji-as-iconography, no inconsistent spacing,
no drop-shadow soup, no five competing accent colors. Every color, badge, radius,
and transition is a deliberate choice traceable to a token.

## Typography

- **Primary: Geist Sans + Geist Mono** (Vercel) — crisp, technical, neutral. Mono
  for IDs, endpoints, code, counts, keyboard hints.
- **"Pixel-ish" accent (to confirm in DESIGN.md):** the user wants a touch that
  makes it stand out — evaluate a crisp pixel/retro display face for the wordmark /
  section eyebrows / empty-state flourishes **only** (sparingly), keeping Geist for
  all body/UI text. Decide during the design consultation; don't let it hurt
  legibility or a11y.
- A real **type scale** (not ad-hoc sizes), consistent line-height/tracking, tabular
  numerals for tables.

## Design system

- **Base:** shadcn/ui pattern — **Radix primitives + Tailwind**, components copied
  into a `packages/web/src/ui/` layer we own (not a black-box dep). Accessibility
  comes largely from Radix; we don't regress it.
- **Tokens (centralized):** color (semantic: bg/surface/border/fg/muted/accent +
  status), spacing rhythm, radius, shadows/elevation, typography, motion durations/
  easings. **Light + dark**, system-aware. Everything references tokens — no magic
  values in components.
- **Component inventory (foundation):** button, input/field + inline validation,
  card, badge/status pill, table (sortable, empty/loading), dialog + sheet/drawer,
  dropdown menu, tabs, tooltip, toast, skeleton, separator, kbd, copy-to-clipboard.
  Plus **empty / loading / error states** as first-class (the dashboard has many).
- **Color & badges — thought through:** a restrained neutral base + **one** confident
  accent; a small, semantic **status palette** (connected/ok, warning, error,
  disabled, info) used consistently for credential/platform/profile/source states.
  Document each badge's meaning + color in DESIGN.md.

## Motion & transitions

- **Principle (Emil Kowalski school):** motion is purposeful and *fast* — it
  clarifies state changes, it never decorates. Subtle, consistent durations/easings
  from tokens. Page/route transitions, dialog/sheet enter-exit, list/row changes,
  toast stacking, optimistic-update feedback.
- Libraries to evaluate: **sonner** (toasts), **vaul** (drawers/sheets), CSS/View
  Transitions or a small motion lib for the rest. Prefer the lightest thing that
  feels great.
- **Respect `prefers-reduced-motion`** everywhere (a11y, not optional).

## Accessibility (a gate, not a nice-to-have)

WCAG AA: contrast on every token pair, full keyboard nav + visible focus rings,
ARIA via Radix, labelled forms + inline errors, reduced-motion, no color-only state
(pair color with icon/text on badges). The `junction-web-reviewer` agent checks this.

## Clean codebase / patterns

- **No business logic in components** — logic stays in `core`; components render +
  call `createServerFn`. Server-only-core boundary preserved.
- `ui/` (primitives) vs feature components vs route files — clear layers. Composition
  over configuration. Tokens + variants (cva-style) over one-off styles.
- Every component ships with a **happy-dom + Testing Library** test (behavior + a11y
  affordances) and renders correctly in light/dark.

## Process & skills (for the increment)

1. **Direction:** `design-consultation` (gstack) → produce `docs/design/DESIGN.md`
   (aesthetic, type, color, spacing, motion) + font/color preview pages. Optionally
   `design-shotgun` to explore a couple of distinct directions before committing.
2. **Build:** `impeccable:frontend-design` (distinctive, production-grade, anti-slop)
   for the system + components; `impeccable:typeset` (type), `impeccable:colorize`
   (palette), `impeccable:animate` (motion), `impeccable:polish`/`delight` (refine).
3. **Animations:** **emilkowalski/skills** (https://github.com/emilkowalski/skills)
   — *not currently installed*; install it for this increment (or apply its
   transition/animation principles directly). It's the reference for motion smoothness.
4. **QA:** `impeccable:critique` (UX scoring) + `design-review` (visual/a11y audit) +
   browser dogfooding via the gstack `browse` skill (screenshots, before/after diffs,
   responsive checks). `junction-web-reviewer` for code-level design/a11y rules.

## Decisions to lock in DESIGN.md (during the increment)

- Final palette (neutral base + accent + status colors) + light/dark defaults.
- Type scale + the "pixel accent" question (yes/where/which face, or drop it).
- Radius/elevation/density language (compact vs comfortable — likely compact for a
  power tool).
- Motion tokens (durations/easings) + which animation lib(s).
- The exact status-badge taxonomy for credentials/platforms/profiles/sources.

## References (quality bar)

shadcn/ui · Vercel dashboard · Linear · Geist design language. Aim for that level of
restraint and polish, with a distinctive junction identity (the wordmark, the accent,
the one memorable detail).
