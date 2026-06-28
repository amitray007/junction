# Anti-AI-Slop — reference for auditing Junction's web UI

> Durable reference behind the **Anti-AI-slop checklist** in `docs/rules/web.md` (the
> enforceable gate) and the DESIGN.md north star ("instrument-grade, not AI-slop").
> Researched 2026-06-28 (deep web research; sources at the end). Use the checklist in
> web.md to audit; use this for the *why* and the intentional alternative.

## The core idea

AI-slop UI isn't ugly — it's **averaged**. LLMs predict the most probable next token, so
they converge on the statistical center of every SaaS page they trained on. The tell is
the **absence of a decision**, and the signal is **convergence**: a single default is
forgivable; 4+ co-occurring defaults = "heavy slop." An audit of 1,590 Show HN pages found
22% heavy slop (4+ tells), 32% mild (2–3), 46% clean — top single tells: permanent dark
theme (34%), gradients (27%), icon-card grids (22%).

## Visual fingerprints → intentional alternative

- **Purple/violet→blue gradients** (the #1 tell; "VibeCode purple") → one confident accent on a near-monochrome base (our Signal Amber). One color used sparingly beats five everywhere.
- **Permanent dark + medium-grey body + all-caps labels** (often fails AA) → deliberate light/dark, tested contrast, aggressively high contrast ("nothing muddy").
- **Flat pure-grey neutrals** → brand-tinted neutrals (our zinc); every surface/shadow/muted-text carries a hue trace.
- **Glassmorphism, colored glows, drop-shadow soup, uniform bubbly radius** → solid surfaces + 1px borders; depth from borders not shadows.
- **Everything centered; badge-above-H1; identical 3-up icon-card grid; "hero metric" stat banner; numbered 1-2-3 steps** → asymmetry, real type hierarchy, one layout primitive used with intent, varied spacing rhythm.
- **Inter/Roboto/system (or Space Grotesk/Geist as the "safe" pick); serif-italic accent word; big rounded icon above every heading** → a real display+body pairing as brand voice (our Geist + Departure-Mono wordmark).
- **Emoji as icons; stock "people-at-laptops" photos; plastic AI illustrations; "Build the future"/"best-in-class" copy** → a real icon set (lucide), product screenshots, copy in the actual voice.
- **Bounce/elastic easing; buttons that snap** → restrained motion on state change, expo-out easing.

## Code patterns that PRODUCE slop (audit the source, not the screenshot)

Each maps to a visual tell:
- Magic values instead of tokens (`bg-[#ff6b35] p-[123px]`) → "random px / no scale" look.
- Copy-pasted Tailwind class strings across near-identical components → "card soup." Fix: a component + cva variant system (abstract at rule of three).
- `<div onClick>` / div-soup instead of `<button>`/`<a>` → not in tab order, keyboard-unreachable (near-universal in AI UI per Frontend Masters).
- Animating `width/height/top/left/margin` instead of `transform`/`opacity` → reflow every frame, ~30fps vs 60. An engine-level tell of unconsidered motion.
- No `prefers-reduced-motion`; missing `aria-*` state; color-only state; no `:focus-visible`/focus management → the near-universal a11y gap.
- Runtime-built class strings (`` `bg-${x}-500` ``) → silently purged by Tailwind.
- `forwardRef` in React 19 (ref is a prop now); dead/over-exported scaffolding; `@apply` overuse; over-nesting / god-components; "AI comment smell" (comments restating code); images without width/height (CLS).

## How experts detect it

The "AI slop test" — would a designer *instantly* say an AI made this? Count co-occurring tells (4+ = heavy). Look for the absence of a decision (no type pairing, no accent strategy, flat neutrals, uniform everything). Programmatic: headless DOM walk + deterministic computed-style checks per tell (don't LLM-judge screenshots); lint for arbitrary Tailwind values, missing `aria-*`, `<div onClick>`, animated layout props, missing reduced-motion; axe/Lighthouse contrast; CLS in Web Vitals; `react-doctor` for the React code smells.

## Junction's standing (audit 2026-06-28, inc 23)

Largely clean — the design-foundation work holds: no magic hex, no inline color, no gradients, no centered hero, real tokens, reduced-motion present, semantic HTML, one teal-not-blue accent strategy. Real findings fixed in the anti-slop pass: emoji theme-toggle icons → lucide; `backdrop-blur` on the dialog overlay → solid; layout-property animation (sidebar width / content margin) → transform/token technique; `forwardRef` → ref-as-prop; dead scaffolding exports; await-in-loop; role-instead-of-tag. See the inc-23 anti-slop commit(s) + the react-doctor baseline.

## Sources

Developers Digest (16-pattern taxonomy + the 1,590-page audit) · Trilogy AI "Fixing Visual AI Slop" · Steve Kinney "Tailwind Anti-Patterns" · 925 Studios "AI Slop Web Design Guide" · Pixeldarts "Four Design Principles Behind Stripe/Linear/Vercel" · Frontend Masters "AI-Generated UI Is Inaccessible by Default" · web.dev "Animations and Performance" / Motion performance tier list · CVA vs Tailwind-Variants · Vercel Academy "Anatomy of shadcn/ui".
