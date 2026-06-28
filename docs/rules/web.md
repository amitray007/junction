# Web Rules (inc 23+)

Rules for `packages/web/` — the TanStack Start SSR dashboard. Each rule is a checkable MUST / MUST NOT.

## Server-only-core boundary (the most critical invariant)

- **MUST NOT** import `@junction/core` (or its transitive deps `better-sqlite3`, `@napi-rs/keyring`) in any module that could be reachable from a client bundle. The three enforcement layers are:
  1. `createServerFn` — the handler body is stripped from the client build.
  2. `*.server.ts` naming — Start's import-protection fails the build.
  3. `vite.config.ts ssr.external` — defence-in-depth for native deps.
- **MUST** run the client-bundle leak grep after every web build:
  ```
  grep -rl "better-sqlite3\|napi-rs/keyring\|@junction/core\|CREATE TABLE\|drizzle" packages/web/dist/client
  ```
  The result MUST be empty. If it fires, trace the import chain back to the `createServerFn` boundary before shipping.
- **MUST** route all core data through `packages/web/src/server/` (`createServerFn` functions). Client components receive typed result shapes, never raw core types.

## Credentials — metadata only

- **MUST NOT** render `secret`, `secretRef`, or any raw credential value in any component or server function return.
- Server functions return only summary metadata: IDs, platform names, account labels, connection status. The shape is defined in `src/server/data.functions.ts`.

## Design tokens (DESIGN.md is the source of truth)

- **MUST** use CSS custom properties (`var(--token)`) from `app.css` for all design values. **MUST NOT** hardcode hex colours, font names, or raw pixel values outside of the `@theme` block in `app.css`.
- **All token additions MUST be recorded in `DESIGN.md`** before being added to `app.css`.
- **Font discipline:**
  - Geist Sans → body copy and UI text (`var(--font-sans)`).
  - Geist Mono → code, IDs, namespaces, numbers (`var(--font-mono)`).
  - Departure Mono → wordmark ONLY (`var(--font-display)`). **MUST NOT** use Departure Mono anywhere except `src/ui/wordmark.tsx`.
- **One accent:** Signal Amber (`--accent-*`). **MUST NOT** introduce a second colour accent.

## Component / UI layer (`src/ui/`)

- **MUST** build primitives from Radix UI + cva + tailwind-merge (`cn()`). Do not reinvent interactive primitives — use Radix for a11y.
- **MUST** use semantic HTML. Biome's `useSemanticElements` is enforced — `<ul>/<li>` not `<div role="list">`, `<button>` not `<div role="button">`, etc.
- **MUST NOT** use `aria-label` on a plain `<span>` without a `role`. Either add a semantic element or add a `role` (e.g., `role="img"`).
- **MUST NOT** render status using colour alone. Status badges MUST show colour + dot + text (see `src/ui/badge.tsx`).
- **MUST** gate View Transitions (and any animation) with `prefers-reduced-motion`. The `@media (prefers-reduced-motion: reduce)` override in `app.css` is the canonical pattern.
- **MUST NOT** add `aria-hidden="true"` to focusable elements without a `// biome-ignore lint/a11y/noAriaHiddenOnFocusable: <reason>` comment explaining why it is non-focusable.

## Accessibility (WCAG AA)

- **MUST** include ARIA landmarks in every page: `<header>`, `<nav>`, `<main>`, `<aside>`. The root layout in `__root.tsx` defines the shell; route components render inside `<main>`.
- **MUST** provide a skip-to-content link as the first focusable element (already in `__root.tsx`).
- **MUST** ensure all interactive elements are keyboard-reachable. Radix handles this for the primitive set; verify when adding new interactive patterns.
- `pnpm --filter @junction/web test` (happy-dom + @testing-library/react) is the a11y regression layer. Tests MUST include a landmark-present assertion for each route.

## Tests

- **MUST** run component tests in happy-dom using `packages/web/vitest.config.ts` (NOT the root Node vitest config, which runs in a Node environment where `document` is undefined).
- **MUST** call `afterEach(() => cleanup())` in every component test file to prevent DOM accumulation across tests.
- **MUST** use destructured query methods from `render()` return values (not `screen.*`) when multiple renders exist in a suite.
- **MUST** write a test for every new route covering: loader data shape renders, empty state renders, ARIA landmark present.
- **SHOULD** write tests for new UI primitives (see `src/ui/*.test.tsx` for the pattern).

## Package hygiene

- `@junction/core` **MUST** be listed in `packages/web/package.json` `dependencies` (Node's module resolver needs it to find the package at SSR runtime) AND **MUST** be in `vite.config.ts` `ssr.external` (prevents bundling its native deps). The dep entry does NOT make it client-safe — `ssr.external` + `createServerFn` is what enforces isolation. **MUST NOT** import `@junction/core` in any client-reachable module (routes, client components, utility files not inside `src/server/`).
- **MUST NOT** use `fs.*Sync` in any server function or loader — keep server code async.
- **MUST NOT** import from `@junction/cli` / `@junction/mcp-server` / `@junction/mcp-client` in `packages/web`. Those are sibling apps; web talks to core only.
- New npm dependencies added to `packages/web` MUST be listed in a PR description with the reason and bundle-impact estimate.

## CI web gate (added to ci.yml at Phase D)

The `web-build` CI job runs on every push/PR and:
1. Builds the web package (`pnpm --filter @junction/web build`).
2. Runs the client-bundle leak grep (must exit 0 / empty output).
3. Runs web component tests (`pnpm --filter @junction/web test`).
4. Runs web typecheck (`pnpm --filter @junction/web typecheck`).

This gate enforces the server-only-core boundary in CI — a planted `@junction/core` import in a client route will fail step 1 (Vite build error) and step 2 (leak grep), whichever fires first.

## Anti-AI-slop checklist (a gate, per DESIGN.md north star "not AI-slop")

"Slop" is the *absence of a decision* — the statistical center of every SaaS template. The tell is **convergence** (multiple defaults co-occurring), not any single choice. Audit visually + in source. Each item below is a **MUST NOT** unless it traces to a deliberate, documented DESIGN.md decision.

**Visual tells (verify in a screenshot):**
- No purple/violet→blue gradients (anywhere); no gradient text on headings/metrics. (Junction: one Signal-Amber accent, no gradients.)
- No glassmorphism / frosted-glass / `backdrop-blur` as decoration; no colored glows / drop-shadow soup. Depth = **1px borders**, not shadows.
- No flat pure-grey neutrals — neutrals are brand-tinted (our zinc ramp). Body text MUST clear WCAG AA.
- No centered hero, no badge-above-H1, no identical 3-up icon-card grid, no "hero metric" stat-banner as the page's reason for being, no uniform-radius/identical-padding-everywhere.
- No `system-ui`/Inter/Roboto as the type; no emoji as icons (use the icon set — `lucide-react`); no "Built for X"/"best-in-class" filler copy.
- No bounce/elastic easing.

**Code smells (verify in source — these PRODUCE the visual slop):**
- No arbitrary Tailwind values (`bg-[#…]`, `p-[123px]`, `text-[14px]`) and no inline hex/px for design decisions — **tokens only** (already a rule above; this is the slop lens on it).
- No runtime-built Tailwind class strings (`` `bg-${x}-500` ``) — breaks static scanning.
- No `<div onClick>` / `<div role="button">` where a `<button>`/`<a>` belongs; no color-only state; motion on `transform`/`opacity` only (never `width`/`height`/`margin`/`top`/`left`), always reduced-motion-gated.
- No `forwardRef` in new components (React 19: `ref` is a prop).
- No dead scaffolding left exported/unimported (the "over-export" tell) — remove or wire it.

**The test:** would a designer instantly say "an AI made this"? If a screenshot stacks 2+ tells, it fails. `junction-web-reviewer` checks this; DESIGN.md decisions are the only sanctioned exceptions (document them).

## react-doctor (on-demand React audit — NOT in the per-edit loop)

`react-doctor` (millionco — "your agent writes bad React, this catches it") is an **on-demand** audit, run by the orchestrator at a web increment's review step, **not** wired into `pnpm verify` or the per-edit hooks (per spec §5b: ~90% of junction is non-React; the loop stays Biome + React Compiler).

- **Run:** `npx react-doctor@latest --verbose packages/web` (or `--scope changed --base <ref>` for a delta; `--json` for a structured report).
- **Triage, don't auto-fix:** its diagnostics are *hypotheses*. Read each in context → true positive / false positive / needs-review. Known false positives here: `serve.mjs` dynamic-import of the built SSR bundle (Node script, not a client chunk); `CardTitle`/heading-has-content (content comes from `children`); intentional static-skeleton array-index keys (already `biome-ignore`-justified). Don't suppress without a code-grounded reason.
- **Fix the true positives** (dead exports/files, `forwardRef`, layout-property animation, await-in-loop, role-instead-of-tag) at the source; re-run to confirm the count drops. It overlaps this checklist + the existing rules — treat it as a second detector, not a separate standard.
