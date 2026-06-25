# Method File 08 — Sandbox Core (Increment 8)

> **The code-execution isolation layer — the last security-critical foundation piece.** A `Sandbox` interface in `@junction/core` with OS-level backends (macOS **Seatbelt** / Linux **bubblewrap** for CLIs) and a **Deno** capability backend for agent JS/TS. The cardinal rule: **refuse to run when no enforceable sandbox is available — never degrade to raw `exec`.** After this increment, the foundation is "ready". The `junction-sandbox-security` reviewer (stubbed since inc 0) **ACTIVATES** — its review is mandatory.
>
> **Builder:** Sonnet, with **maximum care** (same bar as the credential layer). The Seatbelt profile + env-scrub + the refuse-if-unavailable posture were **empirically verified on the target machine** (macOS, no Deno, `sandbox-exec` present) — do not deviate from the verified construction.

---

## Part 1 — Spec (what & why)

### Goal

Give junction a `Sandbox` that runs untrusted code/commands under real OS-enforced restriction, and **refuses** when it can't. Realizes design spec §6/§6b + `docs/rules/security.md`. Proof (runnable on THIS macOS machine, no Deno): a scoped command **runs and returns output**, AND a **forbidden operation is actually denied** (the same op succeeding *outside* the sandbox proves it's real isolation, not the command failing for unrelated reasons).

### The honest platform matrix (load-bearing)

| Backend | This dev machine? | Protects against | Honest gap |
|---|---|---|---|
| **Seatbelt** (`/usr/bin/sandbox-exec`) | **Yes — verified** | FS read-confidentiality (deny subpaths), FS write (allowlist), network (`deny network*`) at the kernel MAC layer | Apple marks `sandbox-exec` **DEPRECATED** (still ships/honors it; Claude Code uses it) |
| **bubblewrap** (`bwrap`) | No — Linux-only | namespaces + bind-mounts (FS + net) | needs unprivileged user namespaces (some distros disable) |
| **Deno** (`deno run --no-prompt --allow-*`) | No — not installed | capability boundary for JS/TS (read/write/net/env scoped) | NOT a syscall jail; `--allow-run`/`--allow-ffi`/eval escape it |
| microsandbox | out of scope | (hardware VM) | escalation tier, later |

**Cardinal posture:** no enforceable backend on the platform ⇒ **`Err`, never raw `spawn`.** This is the single most important property of the increment.

### Interface (Result-returning — mirrors inc-6 CredentialStore shape)

New module `packages/core/src/sandbox/`. `createSandbox(): ResultAsync<Sandbox, SandboxError>` (platform selection, cached probes).
```ts
export interface SandboxPolicy {
  readPaths: readonly string[]    // absolute, realpath-resolved — child may read DATA here
  writePaths: readonly string[]   // absolute — child may write here (implies read)
  allowNet: readonly string[]     // host[:port] allowlist; [] ⇒ network fully denied
  env: Readonly<Record<string,string>>  // EXPLICIT allowlist — NOT process.env
  cwd: string                     // absolute, within read/write paths
  timeoutMs: number               // hard SIGKILL ceiling
  stdin?: string
}
export interface SandboxResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
export interface Sandbox {
  runCommand(argv: readonly string[], policy: SandboxPolicy): ResultAsync<SandboxResult, SandboxError>  // CLI under Seatbelt/bwrap
  runScript(script: { file: string } | { code: string }, policy: SandboxPolicy): ResultAsync<SandboxResult, SandboxError>  // Deno JS/TS
  capabilities(): { command: "seatbelt" | "bubblewrap" | "none"; script: "deno" | "none" }
}
```
`SandboxError` (add to `errors/index.ts`, mirroring `CredentialError`):
`| { kind:"runtime-unavailable"; runtime:"deno"; cause? } | { kind:"unsupported-platform"; platform:string } | { kind:"policy-invalid"; reason:string } | { kind:"spawn-failed"; cause } | { kind:"timed-out"; timeoutMs }`.

> **A DENIED operation is NOT a `SandboxError`.** A blocked read/write/net surfaces as a **nonzero `exitCode`** in an `ok(SandboxResult)` — the sandbox did its job. `SandboxError` is only for "couldn't run the sandbox at all" (tool missing, unsupported platform, bad policy, spawn failure, timeout).

### Key verified constructions (do not deviate)

**Seatbelt profile (verified working on this machine):**
```scheme
(version 1)
(deny default)
(allow process-fork)
(allow process-exec*)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)                              ; broad read so dyld/binaries LOAD (see gotcha)
(deny network*)                                 ; no net (unless allowNet → add per-host allow)
(deny file-read* (subpath "<DENIED_ABS>"))      ; the confidentiality boundary — the credential dir + ~/.junction
(allow file-write* (subpath "<WORKSPACE_ABS>")) ; write ONLY inside the workspace
```
> **THE GOTCHA (verified):** a naive "deny all reads, allow only workspace" profile makes the kernel **SIGABRT every binary (exit 134)** — dyld + the binary loader need broad read through `/` and the dyld cache. So: **broad `file-read*` + explicit `(deny file-read* (subpath …))` for the confidentiality boundary; deny-default only for WRITE (workspace granted).** The distinction between exit 134 (crash — profile too tight, useless) and exit 1 (clean denial — working) is the whole game. Header must be exactly `(version 1)`.
- Invoke: **`sandbox-exec -f <profile-file> -- <argv>`** (file form — clean exit codes verified). Write the generated `.sb` to a per-run temp file (0600), `unlink` after.
- For **every** sandboxed run, the credential dir (`paths.credentialsFile`, `paths.masterKeyFile`) and `~/.junction` go in the `(deny file-read* …)` list — defense in depth beyond env-scrub.

**Deno (when on PATH):** `deno run --no-prompt --allow-read=<readPaths> --allow-write=<writePaths> --allow-net=<hosts> --allow-env=<names> --deny-run --deny-ffi --deny-sys --deny-import <script-file>`. `--no-prompt` (never interactive — missing perm = hard error). **`--deny-run` and `--deny-ffi` are mandatory** (the documented escapes). Write `code` to a temp file in a writePath and pass the FILE (never `deno eval`, never a shell string). Omitting an `--allow-*` flag entirely = zero of that capability (don't pass `--allow-read` with no path — that's allow-all-read).

**bubblewrap (Linux — spec'd from docs, untestable here):** `bwrap --unshare-all --die-with-parent --new-session --clearenv --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /tmp --ro-bind <READ> <READ> --bind <WORKSPACE> <WORKSPACE> --chdir <CWD> --setenv PATH /usr/bin:/bin -- <argv>`. Network OFF = `--unshare-all` (don't add `--share-net`). `--clearenv` + `--setenv` allowlist. **Probe userns at runtime** (`bwrap --ro-bind /usr /usr -- /bin/true`); if it fails → treat as no-command-sandbox (refuse), not raw exec.

### No-secrets-in-sandbox invariant (verified: Seatbelt does NOT scrub env)

1. **Spawn with an EXPLICIT `env:` object** built only from `policy.env` (Node `spawn(..., { env, shell: false })`). Never inherit `process.env`. (Verified: with explicit env, the child sees `JUNCTION_MASTER_KEY` as empty; with default inheritance it leaks.)
2. **Validate `policy.env` at the boundary** → `policy-invalid` if any key matches a secret denylist (`JUNCTION_MASTER_KEY`, `JUNCTION_MASTER_KEY_FILE`, `*_TOKEN`, `*_SECRET`, `*_KEY`).
3. The **CredentialStore is NEVER handed to a sandbox**; resolved plaintext stays in junction's process — never in a child's argv, env, cwd, or the script file.
4. Always `shell: false`, argv as an array (no shell-injection). The profile/script temp files are junction-controlled, never agent-controlled strings.

### Runtime selection + refuse

```
command backend: linux & bwrap-userns-ok → bubblewrap; darwin & sandbox-exec present → seatbelt; else → "none" ⇒ runCommand Err{unsupported-platform}
script backend:  deno on PATH → deno; else → "none" ⇒ runScript Err{runtime-unavailable, runtime:"deno"}
```
Probe once at `createSandbox()`, cache (like inc-6's keyring probe). Windows / userns-disabled / no tool ⇒ **refuse**.

### Visible surface (so the increment is visually testable)

`junction status` shows sandbox capabilities — e.g. `sandbox: seatbelt (commands) · deno not installed (script sandbox disabled)`. Exposes no secret; lets the user *see* what isolation is available. Human + `--json`. (Reuse the inc-6 backend-display pattern.)

### Proof of done

- `pnpm verify` with tests (gated `process.platform !== "win32"`; Seatbelt tests run on macOS, bwrap on Linux, Deno `it.skipIf(!denoAvailable)`):
  - **allowed command runs:** `runCommand(["/bin/cat", allowedFile], policy)` → `ok`, `exitCode 0`, stdout has the content.
  - **forbidden read DENIED:** `runCommand(["/bin/cat", deniedFile], policyWithDeniedInDenyList)` → `ok` with `exitCode !== 0`, empty stdout — AND assert the same read **without** the sandbox succeeds (proves real isolation).
  - **write confinement:** writing outside the workspace → `exitCode !== 0`, file not created; inside → `0`.
  - **network denied:** `runCommand(["/usr/bin/nc","-z","-w2","1.1.1.1","443"], {allowNet:[]})` → nonzero; same op outside → `0`.
  - **no secret leak:** spawn (from a process where `JUNCTION_MASTER_KEY` is set) a child that echoes it → child sees empty.
  - **refuse-if-unavailable:** force `command:"none"` (or mock the probe) → `runCommand` returns `Err{unsupported-platform}`, NEVER spawns. `policy.env` with a `*_KEY` → `policy-invalid`.
  - **timeout:** a `sleep` beyond `timeoutMs` → killed, `timedOut:true` (or `timed-out` Err — pick one, be consistent).
- `junction status` shows the backend; `pnpm depcruise` clean (sandbox is a core module — `core` imports nothing in-repo; node:child_process/fs are fine but **NO `fs.*Sync` in core paths** — use async spawn; the boundary-guard blocks sync). `pnpm build`.
- SPDX; narrow barrel; committed; CI green.

### Out of scope

- microsandbox / libkrun (escalation tier). Actually wiring the sandbox to run real agent code / tool execution (that's the dual-execution FEATURE, post-foundation). Installing Deno (optional, feature-detected). just-bash. Key rotation. The HTTP daemon.

---

## Part 2 — Implementation

### Step 1 — paths + SandboxError

`paths`: the sandbox needs the credential paths for the deny-read list — already on `JunctionPaths` (`credentialsFile`, `masterKeyFile`). Add `SandboxError` to `errors/index.ts`.

### Step 2 — `sandbox/` module (single-purpose files)

```
packages/core/src/sandbox/
  sandbox.ts        ← interface, SandboxPolicy/SandboxResult, createSandbox + platform selection + probes
  seatbelt.ts       ← macOS profile generation (the verified profile) + `sandbox-exec -f` async spawn
  bubblewrap.ts     ← Linux bwrap argv builder + userns probe + async spawn
  deno.ts           ← `deno run --no-prompt --allow-*/--deny-*` argv + PATH probe + async spawn
  exec.ts (or inline) ← the shared async spawn helper: spawn(argv[0], argv.slice(1), { env, cwd, shell:false }), collect stdout/stderr, timeout→SIGKILL, return SandboxResult. NO fs.*Sync; use spawn + promises.
  index.ts          ← narrow barrel: export createSandbox, types
```
- **Policy validation** (shared): all paths absolute; cwd within read/write; `env` has no secret-denylist keys → else `policy-invalid`.
- **Env scrub:** build the child env from `policy.env` ONLY; never spread `process.env`.
- **Deny-read list** always includes the credential paths + `~/.junction`.
- Add the new module to `core/src/index.ts` barrel.

### Step 3 — Seatbelt impl (the one fully testable here)

Generate the verified profile with the denied subpaths (credential dir + anything outside readPaths is already read-denied by... no — read is broad; only the explicit deny-subpaths are blocked, so the credential dir MUST be in the deny list). Write profile to a 0600 temp file; `sandbox-exec -f <profile> -- <argv>` via the async spawn helper with the scrubbed env; `unlink` profile in `finally`. For `allowNet`, add `(allow network* (remote ip "host:port"))` lines per entry (default deny).

### Step 4 — bubblewrap + Deno impls

bwrap argv per §verified-constructions (userns probe gates availability). Deno argv per §verified-constructions (PATH probe gates availability; `runScript` with `{code}` writes a temp `.ts` in a writePath). Both via the shared async spawn helper + scrubbed env. When the backend probe says unavailable → the selection returns "none" and the public method returns the refuse `Err`.

### Step 5 — selection + refuse

`createSandbox`: probe command backend (platform + tool/userns) and script backend (deno PATH), cache. `runCommand`/`runScript` dispatch; if the needed backend is "none" → return the refuse `Err` WITHOUT spawning. `capabilities()` returns the cached probe result.

### Step 6 — `junction status` surface

Add a sandbox capability line (human + `--json`) via a pure `describeSandbox()`-style helper or `createSandbox().capabilities()`. No secrets. Edge stays thin.

### Step 7 — tests (macOS-runnable proofs)

Per Proof-of-done. Use a tmp workspace under `os.tmpdir()`; gate `process.platform`. The forbidden-op tests MUST also assert the same op succeeds outside the sandbox (the anti-theater check). Mock/force the probe for the refuse-if-unavailable + policy-invalid tests so they run on any platform.

### Step 8 — deps, docs, verify, build, commit

- No new npm deps (node:child_process/crypto/fs are built-in; deno/bwrap/sandbox-exec are external binaries, not npm). Update `docs/rules/security.md`: the deprecated-Seatbelt dependency, Deno-optional + install path, **refuse-if-unavailable** posture, the no-secrets-in-sandbox invariant. Update `junction-dev` skill.
- `pnpm verify`; `pnpm build`; the built `junction status` shows the sandbox line; `pnpm depcruise`. SPDX. Commit; push; PR (base main): "feat: sandbox core — Seatbelt/bubblewrap + Deno behind a Sandbox interface (increment 8)".

---

## Review (background, after build) — security-critical, extra rigor

- **`junction-sandbox-security` (ACTIVATES — mandatory):** the refuse-if-unavailable posture (NEVER raw spawn when no backend); Seatbelt profile correctness (broad read + deny-subpath confidentiality boundary, deny-default write, credential dir denied, `(version 1)`); env-scrub (explicit `env:`, secret denylist, no `process.env` inheritance); no secrets in argv/cwd/script/env; `--deny-run`/`--deny-ffi` on Deno; `shell:false` (no injection); the denied-op-returns-nonzero (not theater) + same-op-outside-succeeds proof; timeout→kill; bwrap userns probe.
- Junction: `junction-package-boundary` (sandbox in core; no in-repo deps), `junction-clean-code-reviewer` (no `fs.*Sync` in core — async spawn; Result discipline; narrow barrel; no secret in error `cause`).
- CE: `ce-security-reviewer` (exploitability — sandbox-escape, secret leakage, injection, silent-unsandboxed-fallback), `ce-correctness-reviewer` (platform selection, probe caching, exitCode-vs-Err semantics, timeout), `ce-reliability-reviewer` (process lifecycle/kill, temp-file cleanup, no hang), `ce-testing-reviewer` (the anti-theater negative tests, the refuse/policy-invalid coverage, gated Deno/bwrap skips).
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** `junction status` shows the sandbox backends; AND `pnpm verify` proves on this macOS machine that a scoped command runs (exit 0) and a forbidden read/write/net is actually denied (nonzero, while the same op succeeds outside). **QA'd by me:** drove the built status; ran the Seatbelt proofs (allowed/denied/outside-succeeds, env-scrub) against the real implementation; confirmed refuse-if-unavailable never spawns. **Checklist:** refuse-not-rawexec, Seatbelt profile (broad-read + deny-subpath), deny-default-write, credential-dir-denied, env-scrub + secret denylist, no-secret-in-argv/cwd/script, Deno --deny-run/--deny-ffi, shell:false, denied-op-nonzero-not-theater, timeout→kill, no fs.*Sync in core.

## User test gate

`pnpm build`, then `JUNCTION_HOME=/tmp/jt8 node packages/cli/dist/index.js status` — see the `sandbox:` line (Seatbelt on your Mac; "deno not installed" for the script sandbox). The deeper proof (a forbidden op denied) is in `pnpm verify`. Approve before increment 9 (OpenTUI dashboard — the final foundation increment, after which the foundation is "ready").
