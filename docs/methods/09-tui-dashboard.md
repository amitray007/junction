# Method File 09 — TUI Dashboard (Increment 9)

> **The final foundation increment.** Bare `junction` launches a full-screen, read-only **dashboard** (status · profiles · platforms) rendered over `core`, while every citty subcommand and `--json`/headless path stays intact for scripting/agents. After this, the foundation is complete. The `junction-tui` reviewer (stubbed since inc 0) **ACTIVATES**.
>
> **STACK DEVIATION (decided, empirically proven):** the spec named **OpenTUI**, but OpenTUI's native renderer is **Bun-only** (`bun:ffi`; "native FFI is not available for this runtime yet" — verified under Node 22/24). junction is committed to **Node**. So this increment uses **Ink** (React TUI, Node-native) — same intent (full-screen React TUI over core, headless paths intact), no runtime conflict. Recorded in `docs/futures/` (revisit OpenTUI if/when it ships Node FFI). **Builder:** Sonnet.

---

## Part 1 — Spec (what & why)

### Goal

Give junction a full-screen interactive **dashboard** as the bare-`junction` experience, layered on top of citty — without breaking the scriptable surface. Realizes design spec §6 increment 9 (the "OpenTUI dashboard", now Ink). Proof: the TUI lists profiles/platforms/status live from the DB; `junction status --json` (and every other command/`--json`) still works headless.

### Why Ink, not OpenTUI (the empirical finding)

- `@opentui/core` **imports** under Node but its **native rendering FFI is Bun-only** — `createTestRenderer`/`createCliRenderer` throw `"OpenTUI native FFI is not available for this runtime yet"` under Node (verified). Requiring Bun as a second runtime for a "polish" layer is rejected.
- **Ink 7.1.0**: `type: module` (ESM), `engines: node >=22` (junction's exact target), React 19 peer, renders under Node, `ink-testing-library` for headless snapshot/interaction tests. Used by Claude Code, Gemini CLI, GitHub Copilot CLI — battle-tested. Verified rendering headless on this machine.

### Where it lives + the launch model

- **In `cli`** (`packages/cli/src/tui/`) — cli is the app/composition root that owns the `junction` bin and the three-layer terminal model (citty → @clack → full-screen). No new package (modularity §1; rule-of-three). cli gains runtime deps `ink` + `react`.
- **Launch rule (load-bearing — the headless contract):**
  - `junction <subcommand> …` → citty handles it (unchanged). `--json` always headless.
  - **bare `junction` with an interactive TTY** (`process.stdout.isTTY && process.stdin.isTTY`) → render the Ink dashboard.
  - **bare `junction` with NO TTY** (piped/CI/agent) → do **NOT** launch the interactive TUI (it would corrupt a pipe / hang). Fall back to the headless **`status`** output (or `--json` if requested). This keeps agents safe.

### What the dashboard shows (READ-ONLY this increment)

A full-screen layout with keyboard-navigable panels, all read live from `core`:
- **Status** — home dir, config initialized?, credential-store backend, sandbox backends (`commands=… · scripts=…`). (Reuse the inc-6/inc-8 status assembly.)
- **Profiles** — list from `profilesRepo` (name, `mcpEndpointPath`, source count).
- **Platforms / Credentials** — list from `platformsRepo` + `credentialsRepo` (platform, account label, credential count). **Never a secret value** — only metadata (the credential layer guarantees plaintext never leaves; the TUI shows the *ref/backend*, never the secret).

No mutations (connecting platforms / creating profiles is post-foundation). The dashboard reflects current DB state + a manual refresh.

### Keyboard model

- `↑/↓` (or `j/k`) move within the focused list; `Tab`/`Shift+Tab` (or `←/→`) cycle panels; `r` reload snapshot; `q` or `Ctrl+C` quit (clean exit via Ink `useApp().exit()` — **never `process.exit()` mid-render**, which corrupts the terminal). A footer shows the keybindings.

### No business logic in the TUI (the reviewer's core check)

- React components are **pure presentation**. Data is loaded by a thin `loadDashboardSnapshot()` that calls **core** (`getDatabase`+repos, `getPaths`/config, sandbox/credential `capabilities()`) and returns a plain typed snapshot. No validation/transformation/rules in the TUI — those live in core. The TUI translates core → pixels, nothing more (modularity §4: edges only translate).

### Interface

```ts
// packages/cli/src/tui/index.ts
export function launchDashboard(): Promise<void>   // renders the Ink app; resolves on quit
// packages/cli/src/tui/data.ts
export interface DashboardSnapshot { status: {...}; profiles: [...]; platforms: [...] }
export function loadDashboardSnapshot(paths: JunctionPaths): ResultAsync<DashboardSnapshot, …>
```

### New deps (cli only — it's an app)

- runtime: `ink@^7`, `react@^19`. dev: `@types/react`, `ink-testing-library@^4`. JSX via tsdown/esbuild (`jsx: "react-jsx"` in cli `tsconfig.json` + `tsdown` jsx config). React 19 also aligns with the future web stack.

### Proof of done

- `pnpm verify` with tests (ink-testing-library, headless — no TTY needed):
  - Seed a temp `JUNCTION_HOME` with a DB containing a profile + platform + credential; render the dashboard; assert `lastFrame()` contains the **profile name, platform, and status** (credential backend + sandbox backends). **Assert NO secret value appears.**
  - Keyboard: simulate `↓`/`Tab` → focus/selection moves (frame changes); `q` → app exits cleanly.
  - **Headless integrity:** `junction status --json` still emits valid JSON; bare `junction` with `isTTY=false` produces the headless status (not an interactive render / no hang). A test that drives the root command with a non-TTY stub asserts the fallback.
- `pnpm build`; the built bare `junction` shows the dashboard in a real terminal; `pnpm depcruise` clean (cli→core only; ink/react are external; **no new in-repo edges**); `pnpm quality` (jscpd/syncpack). SPDX; committed; CI green (the TUI tests run headless on Linux/macOS runners).

### Out of scope

- Any mutation (create profile, connect platform, store credential) — post-foundation features. Live DB watching/polling (manual `r` refresh only). Mouse. Themes. OpenTUI (revisit when it ships Node FFI — `docs/futures`).

---

## Part 2 — Implementation

### Step 0 — record the stack deviation (do first)

- `docs/futures/revisit-when.md`: add **"OpenTUI (Node FFI)"** — trigger: OpenTUI ships a Node-compatible native renderer → reconsider migrating the TUI from Ink. `docs/futures/gotchas.md`: add the OpenTUI-is-Bun-only finding (symptom: `"native FFI is not available for this runtime yet"` under Node; fix: use Ink for Node TUIs). Update `CLAUDE.md` Stack line + design-spec §5/§6 reference (OpenTUI → **Ink** for the TUI, with a one-line "OpenTUI deferred: Bun-only renderer" note — keep the spec honest).

### Step 1 — deps + JSX build

- `pnpm add --filter junction ink react`; `pnpm add -D --filter junction @types/react ink-testing-library`. Add `react` to root `pnpm.catalog` if versioned centrally. cli `tsconfig.json`: `"jsx": "react-jsx"`. Confirm `tsdown` builds `.tsx` (esbuild handles JSX; add `tsx` entry/loader if needed). Lazy-import ink/react in the bin so a plain `junction status --json` doesn't pay the React load cost (perf rule).

### Step 2 — data loader (thin, calls core)

`packages/cli/src/tui/data.ts`: `loadDashboardSnapshot(paths)` opens the DB (`getDatabase`), `createRepositories`, lists profiles/platforms/credentials; reads config + credential-store + sandbox `capabilities()`; returns a `DashboardSnapshot` (plain data, Result-wrapped). NO secret values. Reuse existing status-assembly where possible (don't duplicate — DRY).

### Step 3 — Ink components (pure presentation)

`packages/cli/src/tui/` — `App.tsx` (layout: header, panels row, footer; holds focus + selection state via `useState`; `useInput` for keys; `useApp().exit()` on quit; `r` reloads via the loader), `StatusPanel.tsx`, `ProfilesPanel.tsx`, `PlatformsPanel.tsx`, a small `List.tsx` (selectable list with highlight). Use Ink `Box` (flexbox) + `Text`. Pure props-in → render; no core calls inside components (the loader feeds them).

### Step 4 — launch + the headless guard

`launchDashboard()` (`tui/index.ts`): lazy-import ink + App, `render(<App initial={snapshot} reload={…}/>)`, await the instance's `waitUntilExit()`. Wire the **citty root command**: in `cli/src/index.ts`, the main command's run handler — if no subcommand was invoked AND `process.stdout.isTTY && process.stdin.isTTY` → `await launchDashboard()`; else → run the existing headless `status` (respecting `--json`). Ensure subcommands still dispatch normally. **No `process.exit()`** in the TUI path.

### Step 5 — tests

`tui/*.test.tsx` with `ink-testing-library`: seed temp `JUNCTION_HOME` (build a DB via core repos), `render(<App …/>)`, assert `lastFrame()` has the seeded names + status + **no secret**; `stdin.write('[B')`/`'\t'`/`'q'` for nav + exit; assert frame deltas + clean unmount. A `root.test.ts` asserts the non-TTY fallback runs headless `status` (stub `isTTY=false`) and `status --json` is unchanged. Update `.claude/skills/junction-dev` with the `junction` (bare) dashboard.

### Step 6 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` (clean) + `pnpm build`; drive the built bare `junction` in a real terminal (and via the tui-mcp harness for a snapshot if useful). SPDX. Commit; push; PR base main: "feat: Ink TUI dashboard — bare junction full-screen status/profiles/platforms (increment 9)".

---

## Review (background, after build)

- **`junction-tui` (ACTIVATES — mandatory):** Ink patterns (Box/Text/useInput/useApp; clean exit, never `process.exit()`); keyboard/focus handling correct; **headless-path integrity** (bare-no-TTY falls back, `--json`/subcommands unaffected — agents never get a TUI); **no business logic in the TUI** (components pure; data via core); no secret value rendered.
- Junction: `junction-clean-code-reviewer` (thin edge, Result discipline, lazy import, SPDX), `junction-package-boundary` (cli→core only; no new in-repo edges; ink/react external).
- CE: `ce-correctness-reviewer` (focus/selection state, reload, exit lifecycle, the TTY guard), `ce-testing-reviewer` (headless coverage + the non-TTY fallback test + the no-secret assertion), `ce-accessibility`/keyboard if relevant.
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** run bare `junction` in a terminal to see the dashboard; provide the command + the headless proof (`junction status --json` still works). **QA'd by me:** drove the built bare `junction` (TTY) + confirmed the non-TTY fallback is headless (not a hung TUI); ran the ink-testing-library snapshots against seeded data; confirmed no secret rendered; reviews addressed. **Checklist:** Ink-not-OpenTUI (Bun-only, recorded), bare-TTY launches / non-TTY falls back headless, `--json`+subcommands intact, pure components + core data loader (no TUI logic), clean exit (no `process.exit()`), no secret value shown, keyboard nav/quit.

## User test gate

`pnpm build`, then in a real terminal:
```bash
JUNCTION_HOME=/tmp/jt9 node packages/cli/dist/index.js init      # seed a home
JUNCTION_HOME=/tmp/jt9 node packages/cli/dist/index.js            # bare → the dashboard (↑/↓, Tab, r, q)
JUNCTION_HOME=/tmp/jt9 node packages/cli/dist/index.js status --json   # still headless JSON
JUNCTION_HOME=/tmp/jt9 node packages/cli/dist/index.js | cat      # bare + piped (non-TTY) → headless, no hang
rm -rf /tmp/jt9
```
Approve → **the foundation is complete.** Next we discuss the first real feature (connecting a platform — the GitHub wedge).
