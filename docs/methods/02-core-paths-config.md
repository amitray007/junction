# Method File 02 — Core Paths + Config Layer (Increment 2)

> **The first increment with real logic.** Fills the `paths/`, `result/`, `errors/`, `logging/` module seams in `@junction/core` with actual implementations: the `~/.junction` home resolver, a `Result`/error foundation, a logging seam, and a Zod-validated, atomically-locked JSON config read/write layer.
>
> **Builder:** Sonnet (real implementation). Use `/ce-work` if helpful. Obey `docs/rules/` strictly — this is the first code that the rules + boundary tools actually govern.

---

## Part 1 — Spec (what & why)

### Goal

Give `core` a tested foundation that every later increment builds on:
1. **`result/` + `errors/`** — the neverthrow `Result<T,E>` primitives and discriminated-union domain errors (factor-on-first-use per `docs/principles/dry.md`).
2. **`paths/`** — resolve `~/.junction` (override via `JUNCTION_HOME`), plus env-paths for the cache dir, and subpath builders (configFile, etc.).
3. **`logging/`** — a `Logger` interface + a no-op/console default (the seam; pino wired at its later increment).
4. **`config/`** (new module) — load/save a Zod-validated JSON config, with atomic locked writes (proper-lockfile). Fallible ops return `Result`.

This realizes design spec §6 increment 2. **No CLI yet** (that's increment 3) — but the config layer must be driveable so increment 3's `init`/`status` are thin wrappers.

### Decided design (from spec §3 + rules)

- **Home:** explicit `~/.junction`, overridable via `JUNCTION_HOME` env var. Use **env-paths** only for the *cache* dir (not the brand home). Single source: a `paths` module nothing else duplicates.
- **Config file:** JSON at `<home>/config.json`, validated with **Zod** on load (validate at the trust boundary).
- **Locking:** wrap every mutating write with **proper-lockfile** (atomic `mkdir` lock).
- **Errors:** fallible operations return neverthrow **`Result<T, E>`** — no bare throws across boundaries. Domain errors are discriminated unions (e.g. `ConfigError = { kind: "read-failed" } | { kind: "invalid" } | { kind: "write-failed" } | { kind: "lock-failed" }`).
- **No `fs.*Sync` in core** (`docs/rules/performance.md`) — use async `fs/promises`.
- **Lazy-import** proper-lockfile/env-paths inside the functions that need them (keeps core import-light).

### New deps to add (to `@junction/core`)

- `env-paths@^4` (runtime dep)
- `proper-lockfile@^4` (runtime dep) + `@types/proper-lockfile@^4` (devDep)

(zod + neverthrow already present via `catalog:`.)

### Proof of done

- `pnpm verify` passes; **real behavior tests** (not the placeholder) for: paths resolution (default + `JUNCTION_HOME` override), config round-trip (save → load returns equal), invalid-config rejection (load returns `err`), and concurrent-write locking (two writes don't corrupt).
- Every test sets **`JUNCTION_HOME=<tmpdir>`** — no test touches the real `~/.junction` (`docs/rules/testing.md`).
- `Result`-returning functions have tests on **both** `ok` and `err` branches.
- `pnpm depcruise` clean (intra-core imports only; no boundary violations).
- The `core` barrel (`src/index.ts`) re-exports the new public surface **deliberately** (no blanket `export *`).
- The `./testing` subpath helper (`createTempHome` / `withTempHome`) replaces `TESTING_PLACEHOLDER`.
- Committed; PR green.

### Out of scope

- CLI commands (increment 3). The data model (Platform/Credential/Profile — increment 4). Persistence/Drizzle (increment 5). pino itself (later — only the logging *seam* here). The config schema should hold only what's needed now (e.g. a version field + a place for future keys), not the full profile model.

---

## Part 2 — Implementation (step by step)

### Step 0 — tsconfig project references (carry-forward from inc 1)

This increment doesn't add cross-package imports yet (only `core` gets logic), so **no consumer `references` needed this increment.** But when increment 3's `cli` imports `@junction/core`, `packages/cli/tsconfig.json` must add `"references": [{ "path": "../core" }]` so `tsc -b` builds core first. (Recorded here so increment 3 doesn't miss it; nothing to do in increment 2.)

### Step 1 — `result/` module

`packages/core/src/result/index.ts` — thin neverthrow helpers used everywhere:
- Re-export `ok`, `err`, `Result`, `ResultAsync` from neverthrow (so callers import from `@junction/core` not neverthrow directly — one swap point).
- A `fromThrowableAsync` wrapper (or use neverthrow's `ResultAsync.fromPromise`) for wrapping `fs/promises` calls into `Result`.
- Keep it tiny. Per `docs/principles/dry.md`, this is a stable primitive — factor now.

### Step 2 — `errors/` module

`packages/core/src/errors/index.ts` — discriminated-union domain errors. Start with what this increment needs:
```ts
export type PathsError = { kind: "home-unresolvable"; cause: unknown }
export type ConfigError =
  | { kind: "read-failed"; cause: unknown }
  | { kind: "invalid"; issues: string[] }   // Zod validation failures
  | { kind: "write-failed"; cause: unknown }
  | { kind: "lock-failed"; cause: unknown }
```
Provide small constructor helpers if useful (`configReadFailed(cause)` etc.). Each error carries enough context to act on, never a secret.

### Step 3 — `paths/` module

`packages/core/src/paths/index.ts`:
- `resolveHome(): string` — returns `process.env.JUNCTION_HOME` if set (resolved/normalized), else `path.join(os.homedir(), ".junction")`.
- A `JunctionPaths` shape: `{ home, configFile, cacheDir }` where `configFile = <home>/config.json` and `cacheDir` comes from **env-paths** (`envPaths("junction").cache`).
- `getPaths(): JunctionPaths` — pure, reads env at call time (so tests overriding `JUNCTION_HOME` work).
- Async helper `ensureHome(): ResultAsync<JunctionPaths, PathsError>` — creates the home dir (`fs.promises.mkdir(home, { recursive: true })`), returns the paths.
- **No `fs.*Sync`.** Lazy-import env-paths.

### Step 4 — `logging/` module (seam only)

`packages/core/src/logging/index.ts`:
- A `Logger` interface: `{ debug, info, warn, error }` (each `(msg: string, meta?: Record<string, unknown>) => void`).
- A default `noopLogger` (or a thin console-backed one) so callers have something now.
- A `setLogger`/`getLogger` or a passed-in-logger pattern — keep it simple; the point is the *seam* so increment-N can drop in pino without changing call sites. **Never log secrets** (`docs/rules/security.md`).

### Step 5 — `config/` module (new folder)

`packages/core/src/config/index.ts`:
- A Zod schema for the config — minimal now:
  ```ts
  export const ConfigSchema = z.object({
    version: z.literal(1),
    // room for future keys; keep it small
  })
  export type Config = z.infer<typeof ConfigSchema>
  export const DEFAULT_CONFIG: Config = { version: 1 }
  ```
- `loadConfig(paths): ResultAsync<Config, ConfigError>` — read `configFile` async; if missing, return `DEFAULT_CONFIG` (an ok); parse JSON; `ConfigSchema.safeParse`; on failure return `err({ kind: "invalid", issues })`.
- `saveConfig(paths, config): ResultAsync<void, ConfigError>` — validate, then **acquire a proper-lockfile lock**, write atomically (write to a temp file + `rename`), release. Lazy-import proper-lockfile. On lock failure return `err({ kind: "lock-failed" })`.

  > **proper-lockfile gotcha (important):** by default `realpath: true` requires the locked path to **already exist** — but on the first `saveConfig` the config file doesn't exist yet → ENOENT. Handle this: lock the **home directory** (which `ensureHome` guarantees exists) via `lock(home, { lockfilePath: path.join(home, ".config.lock") })`, OR set `realpath: false` and lock a stable lock path. Do NOT lock `config.json` directly with defaults on first write. Pick one approach and note it in a comment; cover first-write in the tests.
- All fs via `fs/promises`. Validate at the boundary (on load).

### Step 6 — `testing/` helper (replace placeholder)

`packages/core/src/testing/index.ts` — replace `TESTING_PLACEHOLDER` with real helpers exported on the `./testing` subpath:
- `createTempHome(): Promise<string>` — make a unique tmpdir (under `os.tmpdir()`), return its path (caller sets `JUNCTION_HOME` to it).
- `withTempHome(fn): Promise<T>` — sets `JUNCTION_HOME` to a fresh tmpdir, runs `fn`, restores env + removes the dir in a `finally`. Use this in tests so no test touches the real home.
- Ensure `tsdown.config.ts` still emits `testing/index.*` (it does — two entries already).

### Step 7 — Wire the barrel

`packages/core/src/index.ts` — re-export the deliberate public surface (NOT `export *`):
```ts
export { ok, err, type Result, type ResultAsync } from "./result/index.js"
export type { ConfigError, PathsError } from "./errors/index.js"
export { getPaths, ensureHome, type JunctionPaths } from "./paths/index.js"
export { loadConfig, saveConfig, ConfigSchema, DEFAULT_CONFIG, type Config } from "./config/index.js"
export { type Logger, getLogger, setLogger } from "./logging/index.js"
export const VERSION = "0.0.0"
```
(Keep `testing/` OUT of the main barrel — it's on the `./testing` subpath only.)

### Step 8 — Tests (colocated `*.test.ts`)

Behavior tests, each using `withTempHome` (`JUNCTION_HOME=<tmpdir>`):
- **paths:** default home is `~/.junction`; `JUNCTION_HOME` override is honored; `cacheDir` resolves.
- **config round-trip:** `saveConfig` then `loadConfig` returns an equal config (`ok`).
- **missing config:** `loadConfig` on a fresh home returns `ok(DEFAULT_CONFIG)`.
- **invalid config:** write garbage / wrong-shape JSON → `loadConfig` returns `err({ kind: "invalid" })` (assert the err branch).
- **locking:** two concurrent `saveConfig` calls don't corrupt the file (both resolve; final file is valid). Assert no throw escapes; result is `ok` or a clean `lock-failed` err.
- Assert **both** `ok` and `err` branches for fallible functions (`docs/rules/testing.md`).

### Step 9 — Add deps, verify, commit

- `pnpm add --filter @junction/core env-paths@^4 proper-lockfile@^4` and `pnpm add -D --filter @junction/core @types/proper-lockfile@^4`. (If `--filter` syntax differs, add to `packages/core/package.json` and `pnpm install`.) Keep them as `catalog:` candidates if syncpack prefers — but single-consumer is fine as a direct dep for now.
- `pnpm verify` (real tests run) + `pnpm build` (core emits) + `pnpm depcruise` (clean).
- Commit; push branch; open PR (base main): "feat: core paths + config layer (increment 2)".

---

## Review (background, after build)

- Junction: `junction-package-boundary` (intra-core only; no new boundary issues), `junction-clean-code-reviewer` (neverthrow no-floating-results, no `fs.*Sync`, `JUNCTION_HOME` test isolation, narrow barrel, no secrets logged).
- CE: `ce-correctness-reviewer` (config load/save edge cases, lock correctness, the err branches), `ce-testing-reviewer` (both-branch coverage, real behavior not implementation), `ce-reliability-reviewer` (lock/retry/concurrent-write handling), `ce-security-reviewer` (no secret in errors/logs; safe file perms on `~/.junction`?).
- Then `/ce-simplify-code` on the diff.

## User test gate

Ask the user to run `pnpm verify` and, if they like, manually: set `JUNCTION_HOME=/tmp/jtest`, exercise `loadConfig`/`saveConfig` via a node one-liner against the built core, confirm `~/.junction`-style home + a valid `config.json`. Approve before increment 3 (CLI boots over core).
