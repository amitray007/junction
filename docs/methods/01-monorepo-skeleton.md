# Method File 01 — Monorepo Skeleton (Increment 1)

> **Hand-off artifact for the Sonnet builder.** Self-contained: spec + step-by-step implementation. Follows `docs/workflow.md` and obeys `docs/rules/`. This is the first increment with real package code.
>
> **Builder:** delegate to a **Sonnet** subagent (per CLAUDE.md). Use `/ce-work` as the execution harness if helpful. The orchestrator reviews after.

---

## Part 1 — Spec (what & why)

### Goal

Stand up the pnpm/TypeScript monorepo skeleton: the workspace, shared tsconfig, build (tsdown) + test (Vitest) wiring, and the five package directories as **real but empty** packages, wired together with `workspace:*` and TypeScript project references. After this, `pnpm verify` runs a **real** typecheck/lint/test across actual packages.

This is the foundation everything else sits on. **No features, no logic** — each package exports a trivial placeholder + has one passing test, proving the toolchain end-to-end. We also lay down `core`'s **named module structure** (per `docs/principles/modularity.md`) as real-but-empty folders, so the modular shape is set from line one (structure, not logic — the logic is YAGNI until each module's increment).

### Package shape (from design spec §2)

```
packages/
  core/          @junction/core        — pure library. Depends on NOTHING in repo.
  mcp/
    server/      @junction/mcp-server   — depends on core (later). Empty shell now.
    client/      @junction/mcp-client   — depends on core (later). Empty shell now.
  cli/           junction              — depends on core. Empty shell now (no commands yet — those are inc 3).
  web/           @junction/web          — depends on core (later). Empty placeholder now.
```

`core` is the only package with real content this increment (a trivial export + test); the others are minimal valid packages so the workspace graph and build are exercised. `cli`'s real commands come in increment 3; `web`/`mcp` fill in later.

### Decided stack (already chosen — do not re-litigate)

- pnpm workspaces · **tsdown** `^0.22` (build) · **Vitest** `^3.2` (test) · **Biome** `^2.5` (lint/format) · TypeScript `^5.9` · **Zod** `^4` (added to core's deps now, used inc 2+) · **neverthrow** `^8` (added to core's deps now, used inc 2+).
- ESM-only, `module/moduleResolution: nodenext`, `target: es2023`, Node 22 LTS (floor 20).
- `tsc -b` with **project references** (each package has its own tsconfig extending `tsconfig.base.json`).

### Proof of done

- `pnpm install` clean (no warnings).
- `pnpm verify` passes and is **real**: `tsc -b` typechecks all packages (no longer a no-op — the guard is removed), `biome check .` clean, `vitest run` runs ≥1 real test that passes.
- `pnpm build` (tsdown) produces `dist/` for each buildable package (`core` at minimum).
- The dependency graph is correct: `@junction/core` has no repo deps; others reference `core` via `workspace:*` only where they actually import it (this increment: none import it yet, so no cross-deps required — keep them out until needed).
- Boundary-guard hook still passes (no violations introduced).
- Committed.

### Every package gets (set at creation — from 0.75/0.9 decisions)

Every `package.json` created this increment **must** include `"private": true` (makes "no npm publish" structural — see 0.75) and `"license": "AGPL-3.0-only"`. Do not omit these; the release tooling and license compliance depend on them from line one.

### Out of scope

- Any real logic: config layer (inc 2), CLI commands (inc 3), data model (inc 4), etc.
- `web`/`mcp` build setup beyond a minimal valid package (they're shells).
- Installing future-domain deps (Drizzle, MCP SDK, TanStack, etc.) — those land at their increments.

---

## Part 2 — Implementation (step by step)

### Step 1 — `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
  - "packages/mcp/*"
```

### Step 2 — `tsconfig.base.json` (repo root)

The compiler options from design spec §3 (including `composite: true`, which enables `tsc -b` project references):

```jsonc
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "lib": ["es2023"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "composite": true
  }
}
```

(`composite: true` is required for `tsc -b` project references.)

### Step 3 — Root `tsconfig.json` (solution file for `tsc -b`)

A references-only file listing each package:

```jsonc
{
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/mcp/server" },
    { "path": "packages/mcp/client" },
    { "path": "packages/cli" },
    { "path": "packages/web" }
  ]
}
```

### Step 4 — `packages/core` (the one real package)

`packages/core/package.json` — **this is the final form; use it verbatim** (note the two `exports` entries: the main barrel + the `./testing` subpath):
```jsonc
{
  "name": "@junction/core",
  "version": "0.0.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./testing": { "types": "./dist/testing/index.d.ts", "import": "./dist/testing/index.js" }
  },
  "engines": { "node": ">=20" },
  "scripts": { "build": "tsdown" },
  "dependencies": { "zod": "^4.4.0", "neverthrow": "^8.2.0" }
}
```

> The `zod`/`neverthrow` versions here become **`catalog:` references in increment 1.5** (syncpack + pnpm catalogs). Hardcode them now; 1.5 migrates them.

`packages/core/tsconfig.json`:
```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/core/tsdown.config.ts` (two entries: the main barrel + the `./testing` subpath):
```ts
import { defineConfig } from "tsdown"
export default defineConfig({
  entry: ["src/index.ts", "src/testing/index.ts"],
  format: ["esm"],
  dts: true,
})
```

**Lay down the named module structure** (per `docs/principles/modularity.md`). Create these folders now as **real-but-minimal** so the modular shape is set from line one — each gets a placeholder `index.ts` and is filled at its increment. **Do not** create a `utils`/`common`/`shared` folder.

```
packages/core/src/
  index.ts          ← the curated public barrel (narrow — NOT export *)
  result/           ← neverthrow wrappers, exhaustive match (inc 2)
  errors/           ← domain-error discriminated unions (inc 2)
  paths/            ← ~/.junction + JUNCTION_HOME resolution (inc 2)
  logging/          ← Logger interface + no-op default; pino wired later (inc 2 seam)
  schema/           ← Zod primitives: branded IDs, __ namespace, refinements (inc 4)
  ids/              ← ULID generation (inc 4/5)
  testing/          ← JUNCTION_HOME tmpdir + fixture helpers (inc 2) — exported on ./testing subpath ONLY
```

This increment: each module folder has a placeholder `index.ts` containing `export {}` (a bare file with no exports is not a module under `isolatedModules`/`verbatimModuleSyntax` — `export {}` makes it a valid empty module). The real implementations land at the increments noted. This is **factoring the structure**, not the logic — the logic is YAGNI until its increment.

> `src/testing/index.ts` is a tsdown entry (Step 4 config) and the `./testing` subpath target, so give it at least a trivial real export this increment (e.g. `export const TESTING_PLACEHOLDER = true`) so the `dist/testing/index.{js,d.ts}` files emit and the subpath resolves. Replace with the real `JUNCTION_HOME` tmpdir helper at increment 2.

`packages/core/src/index.ts` — the curated public barrel (narrow; re-export only what's public, never blanket `export *`):
```ts
/** Junction core — public API. Placeholder until increment 2 (config layer). */
export const VERSION = "0.0.0"
// Module re-exports added as each lands (result, errors, paths, … ).
```

(The `./testing` subpath export is already included in the `core/package.json` above, so test helpers never bloat the main barrel.)

`packages/core/src/index.test.ts`:
```ts
import { expect, test } from "vitest"
import { VERSION } from "./index.js"

test("core exposes a version", () => {
  expect(VERSION).toBe("0.0.0")
})
```

> This trivial test only proves the toolchain end-to-end (Vitest runs, imports resolve). Real behavior tests begin at increment 2, when there's actual logic to assert.

### Step 5 — `packages/mcp/server`, `packages/mcp/client`, `packages/web` (shells)

Each gets a minimal valid package: `package.json` (`@junction/mcp-server` / `@junction/mcp-client` / `@junction/web`, `"type": "module"`, `"version": "0.0.0"`), a `tsconfig.json` extending base with `composite`, and a `src/index.ts` placeholder export (e.g. `export const PLACEHOLDER = true`). No build/test wiring needed beyond compiling under `tsc -b`. Keep them as tiny as possible — they exist to make the workspace graph real and prove `tsc -b` walks all references.

> Note: these have no `dependencies` on `core` yet — they don't import it this increment. Add `"@junction/core": "workspace:*"` only when a package actually imports core (inc 2+). Adding an unused workspace dep now would trip knip later.

### Step 6 — `packages/cli` (shell, real commands in inc 3)

`packages/cli/package.json`: name `junction`, `"type": "module"`, a `"bin"` field pointing at `dist/index.js` (so `npx junction` resolves later), `"version": "0.0.0"`. `tsconfig.json` extending base. `src/index.ts` a placeholder (`export const PLACEHOLDER = true` — no citty yet; that's inc 3).

### Step 7 — Update root `package.json`

- **Remove the typecheck no-op guard.** Change:
  `"typecheck": "test -f tsconfig.json && tsc -b || echo '...'"`
  → `"typecheck": "tsc -b"`. (The root `tsconfig.json` now exists; the guard's job is done. This is the reviewer-flagged change — typecheck must now propagate real `tsc` exit codes.)
- Add a root `"build": "pnpm -r build"` script (recursive build across packages that define one).
- Keep `verify = typecheck && lint && test:ci`.

### Step 8 — Install & verify

- **Add `tsdown` to devDependencies** — it is not yet installed. Add it at the root (`pnpm add -Dw tsdown@^0.22`) so all packages can use it. (Biome correctly skips `dist/` already via `.gitignore` + `useIgnoreFile`, so generated output won't be linted.)
- `pnpm install` (links the workspace).
- `pnpm build` — confirm `packages/core/dist/` is produced with `index.js` + `index.d.ts`.
- `pnpm verify` — confirm real typecheck + lint + the core test all pass.
- Run the boundary-guard test once on a sample to confirm it still behaves (no regression).

### Step 9 — Commit

`git add -A && git commit` with a clear message. The pre-commit hook runs `pnpm verify` — it must pass.

---

## Review (background, after build)

Run in parallel (per `docs/workflow.md` step 6):
- Junction: `junction-package-boundary` (dependency direction + no cross-deps that shouldn't exist), `junction-clean-code-reviewer`.
- CE: `ce-architecture-strategist` (is the skeleton structured well?), `ce-correctness-reviewer` (config correctness), `ce-project-standards-reviewer` (matches our own CLAUDE.md/rules).
- Then `/ce-simplify-code` on the diff.

## User test gate

Ask the user to run `pnpm install && pnpm verify && pnpm build` and confirm green, then approve before increment 2 (core paths + config layer).
