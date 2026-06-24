# Method File 03 — CLI Boots Over Core (Increment 3)

> **The first cross-package increment.** `cli` (`junction`) makes its first real `@junction/core` import — the first edge the depcruise rules (hardened in 1.5) actually govern. Builds a thin citty CLI over the core config layer: `junction init` + `junction status`, both with a headless/`--json` path.
>
> **Builder:** Sonnet. Obey `docs/rules/` — the CLI is an **edge: thin, translation-only.** No logic in the CLI that belongs in `core`.

---

## Part 1 — Spec (what & why)

### Goal

Make junction runnable end-to-end from the terminal, over the existing `core` paths+config layer:
- `junction init` — ensures the `~/.junction` home exists and writes the default config (via `saveConfig`). Interactive confirmation via @clack/prompts; **`--yes`/`--json` skips prompts** for headless use.
- `junction status` — reads state (home path, whether config exists + its contents) via `getPaths`/`loadConfig` and prints it. **`--json` emits machine-readable output.**

This realizes design spec §6 increment 3. The CLI is a **thin wrapper**: it parses argv, calls `core`, formats output. All real logic stays in `core`.

### The three-layer terminal model (spec §3, increment 9)

- **citty** owns `junction <cmd>`, flags, the `npx` entry point.
- **@clack/prompts** handles inline interactive wizard steps (e.g. `init` confirmation).
- **OpenTUI** (increment 9) becomes the full-screen dashboard later — NOT this increment.
- **Scriptable always:** every command keeps a non-interactive `--json`/`--yes` path so an agent can drive it (`docs/rules/` "scriptable paths stay scriptable"). Interactive prompts must never be the *only* path.

### Decided design

- **citty** for the command tree; lazy-import @clack/prompts inside the `init` handler only (keeps `status`/`--json` cold-start fast — `docs/rules/performance.md`).
- **consola** for human output, **NOT** raw `console.log` for status/errors; `--json` output goes to stdout as a single JSON document (consola to stderr for human notes, or a clean stdout JSON — keep `--json` output pure so it's pipeable).
- Errors: `core` returns `Result`; the CLI **translates** an `err` into a non-zero exit code + a human message (or a JSON error object under `--json`). The CLI MAY throw/exit at its top level (it's the process boundary), but it consumes every `Result` from core — no floating results.
- `bin` already points at `dist/index.js` (shebang needed — see Step 4).

### New deps (to `junction` cli package)

- `citty@^0.2` (runtime), `@clack/prompts@^1` (runtime, lazy-imported), `consola@^3` (runtime).
- `@junction/core: "workspace:*"` — the first workspace dependency edge. (zod/neverthrow come transitively via core; the CLI shouldn't need them directly yet.)

### Proof of done

- `pnpm build` then `node packages/cli/dist/index.js init` creates `$JUNCTION_HOME` with a valid `config.json`; `... status` prints it; `... status --json` emits valid JSON.
- End-to-end test (Vitest) driving the built CLI (or the command handlers) under `JUNCTION_HOME=<tmpdir>`: `init` → `status` round-trips; `status --json` parses; a fresh `status` (no init) reports "not initialized" cleanly (non-zero or a clear state, not a crash).
- **`pnpm depcruise` clean** — `cli → @junction/core` is the allowed direction; confirm no violation now that a real edge exists.
- `pnpm verify` passes; `tsc -b` builds core THEN cli (project references — Step 1).
- No logic in the CLI that belongs in core; narrow, translation-only handlers.
- SPDX headers; committed; PR green.

### Out of scope

- The data model / profiles (increment 4) — `status` shows config + paths only, not profiles.
- Any platform connection, MCP, credentials. The TUI (increment 9). `npm`-publishing the bin (still `private`).
- A full command framework — just `init` + `status` (+ the citty root with `--version`).

---

## Part 2 — Implementation (step by step)

### Step 1 — tsconfig project reference (the inc-1/inc-2 carry-forward — DO THIS)

`cli` now imports `@junction/core`, so `packages/cli/tsconfig.json` **must** declare the reference so `tsc -b` builds core first and the edge is machine-checked:
```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
  "include": ["src"],
  "exclude": ["**/*.test.ts"],
  "references": [{ "path": "../core" }]
}
```
(`types: ["node"]` matches what core needed — the CLI uses `node:process` etc.) Verify `tsc -b` from clean builds core then cli in order.

### Step 2 — cli `package.json` deps

Add `"@junction/core": "workspace:*"` to dependencies, plus `citty@^0.2`, `@clack/prompts@^1`, `consola@^3`. Add a `"build": "tsdown"` script and a `tsdown.config.ts` (entry `src/index.ts`, format esm, the `.js` outExtension like core, and a **shebang banner** — see Step 4). Keep `private: true` + AGPL.

### Step 3 — command structure

```
packages/cli/src/
  index.ts            ← citty main: defineCommand root (name "junction", version),
                        subCommands { init, status }. Shebang. runMain(...).
  commands/
    init.ts           ← defineCommand: ensureHome + saveConfig(DEFAULT_CONFIG);
                        @clack confirm unless --yes/--json; consola success.
    status.ts         ← defineCommand: getPaths + loadConfig; print human table OR
                        JSON under --json. Exit non-zero if not initialized (no config).
  format.ts           ← tiny helper: render status as human text vs JSON (one place).
```
Keep `commands/` flat — per `docs/principles/dry.md`, do NOT build a generic "command base" abstraction for two commands. Two `defineCommand`s that look similar is fine (accidental similarity, not real duplication).

### Step 4 — shebang + executable bin

- The built `dist/index.js` must start with `#!/usr/bin/env node` so `junction` runs as a bin. **Preferred:** put the shebang as the first line of `src/index.ts` (before the SPDX comment) — tsdown/rolldown preserves a leading shebang in the entry into the output. If that doesn't survive the build, fall back to a tsdown `banner`-style output option. **Verify empirically:** `head -1 packages/cli/dist/index.js` shows the shebang. (Note: the SPDX header then goes on line 2.)
- The `bin` field already points at `./dist/index.js`. Confirm `node dist/index.js --help` runs.

### Step 5 — `init` command

- Args: `--yes` (skip confirm), `--json` (machine output, implies no prompts).
- Flow: `ensureHome()` → if `err`, translate to exit-1 + message. If not `--yes`/`--json`, @clack `confirm` "Create junction home at <path>?"; on cancel, abort cleanly. Then `loadConfig` — if config already exists, report "already initialized" (idempotent, not an error). Else `saveConfig(paths, DEFAULT_CONFIG)`; translate `err` → exit-1.
- Output: human → consola success with the home path; `--json` → `{ "ok": true, "home": "...", "created": true|false }`.
- **Lazy-import @clack/prompts** inside the handler.

### Step 6 — `status` command

- Args: `--json`.
- Flow: `getPaths()`; `loadConfig(paths)`. If config missing (`ok(DEFAULT_CONFIG)` returned because file absent — distinguish "file exists" vs "defaulted": check existence, or have status report `initialized: <bool>`). Print: home path, cacheDir, configFile, initialized?, config contents.
- Output: human → a small consola/aligned text block; `--json` → `{ "home", "configFile", "cacheDir", "initialized", "config" }` as ONE pure JSON document on stdout (no consola noise mixed in — pipeable).
- Not-initialized: `--json` still returns valid JSON (`initialized: false`); human prints a hint to run `junction init`. Exit code: 0 for a successful status read (even if not initialized — status succeeded); reserve non-zero for actual read errors.

### Step 7 — tests (Vitest, `JUNCTION_HOME=<tmpdir>`)

Drive the command handlers (import and call them) or the built CLI via `node:child_process` (`execFile` the built `dist/index.js` with `JUNCTION_HOME` in env). Prefer calling handlers directly for speed, plus ONE child-process smoke test that the built bin runs. Cases:
- `init` on a fresh home creates `config.json`; `status --json` then reports `initialized: true` + the config.
- `init --json` is non-interactive (no hang) and emits valid JSON.
- `init` twice is idempotent (second reports already-initialized, exits 0).
- `status --json` on a fresh (un-init) home → valid JSON, `initialized: false`, exit 0.
- The `--json` output of `status` is **pure parseable JSON** (no log lines mixed in).
- Use `withTempHome` from `@junction/core/testing`.

### Step 8 — deps, verify, build, commit

- `pnpm add --filter junction @junction/core@workspace:* citty@^0.2 @clack/prompts@^1 consola@^3`.
- `pnpm install`; `pnpm verify`; `pnpm build`; `pnpm depcruise` (clean — confirm the cli→core edge is allowed and no reverse/cross-edge introduced).
- Manually: `JUNCTION_HOME=/tmp/jt node packages/cli/dist/index.js init --json` then `... status --json` — confirm real end-to-end.
- SPDX headers on all new `.ts`. Commit; push branch; open PR (base main): "feat: cli boots over core — init + status (increment 3)".

---

## Review (background, after build)

- Junction: `junction-package-boundary` (**the first real cross-package edge** — confirm cli→core is the only new edge, no reverse/cross-edge, depcruise green), `junction-clean-code-reviewer` (edge stays thin — no core-logic in cli; `--json` paths pure; no floating Results; consola not raw console; lazy @clack import).
- CE: `ce-correctness-reviewer` (init idempotency, not-initialized handling, exit codes, err translation), `ce-testing-reviewer` (handler + bin coverage, `--json` purity test), `ce-reliability-reviewer` (prompt-cancel + error paths don't hang or crash), `ce-agent-native-reviewer` (every command has a scriptable/`--json` path — agents can drive it).
- Then `/ce-simplify-code` on the diff.

## User test gate

Ask the user to: `pnpm build`, then `JUNCTION_HOME=/tmp/jtest node packages/cli/dist/index.js init` and `... status` (and the `--json` variants) — confirm a real `~/.junction`-style home + readable status. Approve before increment 4 (data model).
