<!-- SPDX-License-Identifier: AGPL-3.0-only -->
---
increment: 33 (Slice D — junction run CLI)
title: Code Mode Slice D — `junction run` CLI command
depends_on: [33a, 33b]
touches: [cli]
---

# Inc 33 Slice D — `junction run` CLI

A thin CLI edge over Slice B's engine: run agent JS from a file against a profile. Full context: `docs/methods/33-code-mode.md`. Independent of Slice C (different files) — can build in parallel with it.

**Proof-of-done:**
1. `junction run <file.js> --profile <name>` reads the JS file, builds the profile's ProfileProxy (exactly as `mcp serve` does), runs Slice B's `runCode` over it, and prints the returned value + captured logs/emits.
2. `--json` headless: emits `{ ok, value?, logs, emitted, toolCallCount, error? }` — scriptable per the "every command keeps a --json path" rule.
3. Each in-code tool call is audited (Slice B) + the wrapping code_exec.
4. `pnpm verify` green.

## Read first
- `packages/cli/src/commands/mcp.ts` / `serve.ts` — the exact sequence to build a ProfileProxy (ensureHome, getDatabase, createCredentialStore, makeResolveProvider, createProfileProxy) + the audit sink (`createFileAuditSink`) + the principal (stdio principal for a local run). Reuse this — do NOT reinvent.
- `packages/cli/src/index.ts` — citty command registration pattern.
- Slice B's `@junction/code-mode` `runCode(code, proxy, {principal, sink, opts})`.
- `docs/rules/` — the scriptable `--json` requirement; the argv→core thin-edge rule.

## Changes
1. **`packages/cli/src/commands/run.ts` (new):** a citty command `run`. Args: `<file>` (positional, the JS file — read via async fs), `--profile <name>` (required), `--json`, optional `--timeout <ms>`. Build the ProfileProxy + audit sink + a stdio-shaped principal (the run is local, single-profile — mirror how `mcp serve` constructs its principal). Call `runCode`. On `--json`, print the structured result; else pretty-print value + logs. Flush the audit sink on exit (mirror mcp.ts's flush). Typed errors, no bare throw.
2. **Register** the command in `cli/src/index.ts`.
3. A file-not-found / bad-profile / empty-code path returns a clean typed error (not a stack).

## Hard invariants
- Thin edge: argv → build proxy → runCode → format. No engine logic in cli (it's in code-mode).
- The credential never reaches the guest (proxy resolves host-side).
- `--json` path is complete + machine-parseable (agents drive it).
- Audit sink flushed on exit; stdout carries only the intended output (logs/errors → stderr or the --json envelope, not interleaved into a machine-read stdout).

## Do NOT
- Do NOT duplicate Slice B's engine or the facade in cli.
- Do NOT read the JS file with fs.*Sync (async).
- No push. Commit locally.

## Steps
1. run.ts + registration + tests → commit. 2. QA: build; seed a temp JUNCTION_HOME with a profile + a real source; write a `demo.js` that calls a tool and returns a computed value; `junction run demo.js --profile <p> --json` → correct structured output; the audit.log shows the inner tool_call + wrapping code_exec; a bad profile → clean typed error. Report the transcript.
Report: files, the run command surface + --json shape as shipped, QA transcript, verify summary.
