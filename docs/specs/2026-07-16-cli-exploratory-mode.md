# CLI Exploratory Mode — Design Doc

_Status: DRAFT (autonomous build). Raised at the inc 40 boundary. Slices land as increment 41._
_Source of truth for the "install a CLI once, let the agent drive it" pivot._

## 1. The wedge

Today a Junction **CLI platform** requires the operator to declare **every command as a locked-down tool** — a fixed `argv` template + per-arg validation + a per-tool sandbox policy (`packages/core/src/schema/cli-connection.ts`). Adding `gh` means hand-authoring one `CliTool` per `gh` subcommand you want. That is the friction we are removing.

**New model:** install a CLI trivially (by name), and from then on an AI agent can do **anything that CLI can do**, discovering the interface itself. Per-tool authoring becomes *optional sugar*, not the price of admission.

This is deliberately a **two-tier** design (decided with the user):
- **declared** (today's model) stays the safe default.
- **exploratory** is an opt-in capability per platform that unlocks agent-driven use of the whole CLI.

The trust boundary stays **the sandbox, always** — every CLI interaction, including `--help` extraction, runs sandboxed. Composed agent argv is treated as hostile (prompt-injectable).

## 2. Why this is now cheap to reach (research findings)

Two facts from the codebase make this a natural extension rather than a rewrite:

1. **The gh CLI catalog surface already exists but is a dead path.** `packages/core/src/apps/catalog/github/catalog.json` ships a `kind:"cli"` surface (`credentialEnvVar:"GH_PAT"`) with **no `starterTools`**, so `buildPlatformInput` (`packages/core/src/apps/build-recipe.ts:375-406`) refuses it with `descriptor-no-starter-tools`. That surface is exactly the "install gh, let the agent use it" case — exploratory mode makes it connectable without anyone authoring starter tools.

2. **The sandbox already unifies command execution.** `Sandbox.runCommand(argv, policy)` (`packages/core/src/sandbox/sandbox.ts:219`) fails closed, replaces env (never inherits `process.env`), denies network on `allowNet:[]`, and caps output at 1MB / 10min SIGKILL. An `execute` tool is a `runCommand` consumer — the binary is a real fixed executable, not agent-authored code, so it fits the existing `cli` threat model exactly (it is NOT a `runScript`/Deno consumer).

## 3. Hard constraints (fixed — design within them)

From research (`sandbox.ts`, `exec.ts`, `cli-connection.ts`, `verify-credential.ts`):

1. **argv[0] must be an absolute path resolved BEFORE the sandbox** — no PATH inside the sandbox. Binary discovery is a pre-sandbox step; no discovery code exists today.
2. **No shell, ever** (`spawn(..., {shell:false})`). Composed argv is an array, never a shell string.
3. **argv[0] literal is metachar-checked** (`hasUnsafePathChars`) because it is interpolated into the Seatbelt SBPL profile.
4. **Every granted path must be absolute + metachar-clean**, and **must not be an ancestor of the secret files** (`grantedPathExposesSecrets`, realpath-resolved both sides).
5. **Credential = one env var**; keys ending `_TOKEN`/`_SECRET`/`_KEY` (and `JUNCTION_MASTER_KEY*`) are denylisted by `validatePolicy`.
6. **1MB per-spawn output cap, 10-min max timeout, SIGKILL on breach.** No aggregate/cross-call budget exists — a recursive `--help` extractor must impose its own.
7. **No sandbox batching primitive** — each `runCommand` re-runs `validatePolicy` (realpath I/O) + regenerates an SBPL profile (macOS `mkdtemp`+`writeFile`+`rm`). Per-subcommand `--help` has real per-call cost; the extractor must bound probe count.
8. **`cli` is currently hard-coded "not-verifiable"** (`verify-credential.ts:246`) because "running a command has side effects." Auto-`--help` must reconcile this (see §5 / Q3).
9. **Fail-closed on missing sandbox backend** — `runCommand` refuses with a typed error, never a raw exec. Must stay true.

## 4. Architecture — the three layers

### Layer 0: schema — `CliConnection` gains a mode

`CliConnectionSchema` becomes a discriminated shape:
- `mode: "declared"` (default, back-compat) — `tools: CliTool[]` as today.
- `mode: "exploratory"` — carries the resolved absolute `binaryPath`, the `credentialEnvVar`, a **platform-level** `CliPolicy` (one policy for the binary, not per-tool), the persisted **extracted schema**, and optional `shortcuts: CliTool[]` (the demoted declared-tool model).

Storage reuses the existing `platforms.cli` JSON column (`packages/core/src/db/schema.ts:21`) — no migration needed if the extracted schema lives inside the `CliConnection` JSON. (Open: if the extracted schema is large enough to warrant its own column/lifecycle, add `cli_schema` via drizzle-kit generate — decided in the method file.)

### Layer 1: `execute` — the general run tool

For an exploratory platform, `createCliProvider.listTools()` returns generic tools instead of a 1:1 projection. `execute` takes an **agent-supplied argv array** (the tokens AFTER the binary), which is:
- length/element-count capped,
- each element metachar/length validated,
- prepended with the fixed absolute `binaryPath` as argv[0],
- run under the platform-level `CliPolicy` in the sandbox.

The existing flag-injection guard generalizes: since the agent now legitimately supplies flags, the guard shifts from "no leading `-` unless `--` present" to "the sandbox + policy is the boundary" (no shell, binary fixed, net/fs/env scoped, credential is one env var). This is the crux the user signed off on: **the sandbox is the trust boundary**.

### Layer 2: `help`/schema — Junction's extracted interface

At install, Junction runs the binary's `--help` **recursively, sandboxed, credential-free, no network**, and extracts a structured command tree (subcommands, flags, each with its own help). Persisted per platform. The agent reads this via a `help` tool (or resource) and never has to spend round-trips running `--help` itself.

- Extractor is a **pluggable interface**: a generic best-effort parser now (handles common `usage:` / `Commands:` / `Flags:` conventions), with a **raw-help fallback** when parsing fails, and room for per-CLI/LLM extractors later. Junction core stays LLM-free.
- Recursion is bounded by a **probe ceiling** (Q4).

### Layer 3: shortcuts — optional sugar

The current declared-`CliTool` becomes an optional `shortcuts[]` on an exploratory platform: named saved commands (e.g. "list my PRs" → `gh pr list --json ...`) that surface as their own named MCP tools alongside `execute`/`help`. Zero required; power-user convenience. This *reuses* the existing `CliTool` machinery (argv template, validation, per-tool policy) verbatim.

## 5. Product decisions (Fable — binding)

> Decided by the Fable product-owner subagent. Binding.

- **Q1 Binary discovery scope:** Search **PATH + common install dirs** (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.cargo/bin`, `~/go/bin`). Show **all matches with versions**; **recommend the first-in-PATH hit** ("what your shell would run", not highest version). Dedupe candidates by `realpath`. Persist the chosen **absolute realpath** at install; if it later vanishes/changes, surface a "binary moved — re-confirm" state (never silently re-discover). **Manual path entry always available.**

- **Q2 Tool shape:** Exactly two tools. **`<ns>__execute`** — args `{ args: string[] (argv AFTER the binary), stdin?: string }`; **binary is implicit/pinned, agent never supplies argv[0]**. Returns `{ exitCode, stdout, stderr, truncated, durationMs }`. MCP annotations `readOnlyHint:false, destructiveHint:true, openWorldHint:true`. **`<ns>__help`** — args `{ path?: string[] }` (e.g. `["pr","create"]`, omitted = root); returns **one node + shallow child index**: `{ path, parsed, description, usage, flags[], positionals[], subcommands[] (names+summaries only), rawHelp? }`. No `__search` (v2 at most).

- **Q3 `--help` reconciliation + gating:** Recursive `--help` is a **safe automated probe class** (`<pinned-binary> [subpath...] --help`, **no credential, no network, read-only FS**) — no separate consent dialog; the one install confirmation states plainly that Junction will run the `--help` tree sandboxed/offline/credential-free. The "cli not-verifiable" rule stands only for *credentialed, networked* invocations. Runtime **`execute` is fully open once Full CLI access is on** — no per-call approval; **every invocation audit-logged with full argv** (secrets never in argv by construction).

- **Q4 Probe ceiling:** **depth 5, 400 total probes, 10s/probe, 5-min wall-clock.** Ceilings **never abort install** — keep partial schema, mark unreached nodes `explored:false`, **probe them lazily on first `help` call** (same limits) and persist. Loop detection: hash normalized help text; if a child hashes identical to an ancestor, stop that branch. Install summary states what was mapped vs. deferred.

- **Q5 Extraction failure / agent contract:** **One schema tree, always present**; every node carries **`parsed: true|false`**; `rawHelp` returned on `parsed:false` nodes. **Never drop a node.** Raw help persisted on disk for every node; only *returned* when parsing failed.

- **Q6 Naming & mental model:** User-facing term **"Full CLI access"** (never "exploratory mode" in UI). Per-platform setting: `Access: Declared commands (default) / Full CLI access`. Agent-facing: `<ns>__execute`, `<ns>__help`; saved shortcuts keep `<ns>__<tool>` form, labeled "Shortcuts (saved commands)". Install copy:
  > **Full CLI access** — Agents connected to this profile can run any `gh` command, always inside the sandbox. Junction learns `gh`'s commands once at install (by running its `--help` — sandboxed, offline, no credentials) so agents know the interface without trial and error. You can still pin named shortcuts for commands you want locked down.

### Cross-cutting (binding)
- The pinned absolute realpath is the **only** binary `execute` can run; re-pinning requires explicit user action.
- Lazy probing uses the identical safe-probe class (no creds/net/write).
- Declared tools remain the default for every new CLI platform; Full CLI access is opt-in per platform.

## 6. Slice plan (increment 41, parallel waves)

- **41.1 core (blocking):** `CliConnection` mode discriminant + exploratory shape + extracted-schema type + storage. `touches: [core]`, `parallel_group: A`.
- **41.2 extractor:** pluggable extractor interface + generic parser + raw fallback + sandbox-always recursive `--help` with probe ceiling. `depends_on: [41.1]`, `touches: [core/sandbox, core/cli]`, group B.
- **41.3 execute+help provider:** exploratory `listTools`/`callTool` in `createCliProvider`; wire through `buildProvider`. `depends_on: [41.1]`, `touches: [core/cli, source-runtime]`, group B.
- **41.4 discovery install:** binary search + recommend; CLI headless path + web install panel; credential in same flow. `depends_on: [41.1]`, `touches: [core, cli, web]`, group C.
- **41.5 shortcuts-as-sugar:** demote declared tools to optional `shortcuts` on exploratory platforms. `depends_on: [41.1, 41.3]`, group C.

Serial integration in one tree, `pnpm verify` after each slice. Reviews per-slice.

## 7. Proof-of-done

Install `gh` in exploratory mode via the web UI (discovery finds `/opt/homebrew/bin/gh`), confirm the extracted schema captures `gh`'s subcommand tree, then drive `execute` + `help` through MCP against the **real sandboxed `gh`** (authenticated via `GH_PAT`) and confirm an agent can list PRs / repos with **zero per-tool declaration**. `pnpm verify` green; junction reviewers + `junction-web-verify` clean.
