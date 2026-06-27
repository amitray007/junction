# Method File 21 — Sandboxed code-execution source (`cli` platform kind)

> **Wire the dormant sandbox to a real, least-privilege feature.** Increment 8 built OS-level isolation (Seatbelt / bubblewrap / Deno) but nothing executes through it. This adds a `cli` source kind: the operator declares a **fixed set of named commands**, each a binary + an **argv template** + a per-tool **SandboxPolicy** + a typed arg schema. Each becomes one namespaced tool. The agent supplies only declared argument *values* — every value lands in **exactly one argv element**, passed to the sandbox with **no shell**. junction becomes a safe gateway to local tools (`git`, `rg`, a data script), not just remote APIs.
>
> **This is the most security-sensitive increment.** The whole design is least-privilege, operator-fixed, no-shell, argv-array, validate-args, fail-closed. **`junction-sandbox-security` is the lead reviewer** (this is its activating increment). Two things must be exactly right: (1) agent input can NEVER reach a shell or widen argv; (2) do NOT weaken the shared `validatePolicy` secret-spill guard — work *with* it.
>
> **Builder:** Sonnet. Lives in `core` (no external deps — just `createSandbox` + Zod), per the "named core module, not a new package" principle.

---

## Part 1 — Spec (what & why)

### Goal

`platform add --kind cli` (JSON descriptor) registers a code-exec source; serving/probing a profile that references it exposes one tool per operator-declared command. The agent calls `<ns>__<tool>` with declared args → junction validates the args, builds an argv array, runs it through `createSandbox().runCommand(argv, policy)` under the per-tool policy, and returns stdout/stderr/exit. Proof: a `cli` platform exposing e.g. `echo`/`rg`/a script runs end-to-end; an injection attempt (`; rm -rf`, `--output=/etc/passwd`, `../../etc/passwd`) is inert/rejected; a secret reaches the process only via its env var, never argv/logs/results; on a host with no sandbox backend the call **refuses** (never raw-execs).

### Tool surface — operator-declared named commands ONLY

- **No generic `run(commandString)` tool — ever.** A shell-string `run` is the one anti-pattern every unsafe MCP shell server shares (routes through `sh -c` → trivially injectable) and is incompatible with junction's profiled/least-privilege thesis. Refused outright, not deferred.
- The operator enumerates commands in the descriptor; **one tool per command**. The agent cannot invent commands or add flags — only fill declared arg slots.
- **argv is a structured template, not a string:** an array of segments — `{kind:"literal", value}` and `{kind:"arg", name, prefix?}`. Building the argv: literal → its value; arg → **exactly one** element `(prefix ?? "") + String(validatedValue)`; optional-absent arg → omit. No segment ever yields >1 element, so the agent can't widen argv. `argv[0]` MUST be a literal **absolute** binary path (the sandbox has no PATH — explicit env only).
- The operator may place a literal `"--"` segment before agent-controlled positionals (end-of-options convention) to defeat flag-reinterpretation.

### Security model — operator-fixed vs agent-controlled

- **Operator-fixed (descriptor data):** the binary (`argv[0]`, absolute), the whole argv template, the full `SandboxPolicy` (readPaths, writePaths, allowNet, cwd, timeoutMs, static env), the credential binding (`credentialEnvVar`), and per-arg validation.
- **Agent-controlled:** only the *values* of declared args — each validated, each in one pre-positioned argv slot. Nothing else.
- **Division of labor on injection:**
  - **The sandbox is the boundary.** `runCommand` confines filesystem (readPaths/writePaths) and network (`allowNet:[]` = denied). `/etc/passwd` / `../../etc/passwd` can't escape; phone-home is blocked — regardless of arg validation.
  - **The provider validates arg *shape*** (defense-in-depth, clean `invalid-args` before spawn): strict Zod from `tool.args` (`additionalProperties:false`, reject unknown/missing/wrong-type); operator-supplied anchored `pattern`; `enum`; `maxLength`; `type:"path"` → must be relative, no `..`, `path.join(cwd, value)` stays within cwd.
  - **`validatePolicy` (already in core) protects this provider for free:** it rejects SBPL/argv metachars (`" \ ( ) , NUL LF CR`) in any path/cwd/allowNet entry before any profile/argv is built, and the exposure check refuses a tool whose granted paths are an ancestor of `~/.junction`/the credential dir. Agent arg values go ONLY into argv (shell:false), never into the SBPL profile — the injection surface isn't even reachable from agent input. **Do not modify `validatePolicy` in this increment.**

### Credentials — secret-as-env (v1)

A code-exec source usually needs a secret (a token for a CLI). v1 injects it as **one env var**: resolve via the existing `resolveCredentialSecret`, pass `secret` to `createCliProvider(connection, secret)`; build `policy.env = secret && credentialEnvVar ? {...envAllow, [credentialEnvVar]: secret} : {...envAllow}`. The secret appears in **exactly one place — `policy.env` → the child's environment**: never argv (so never in `ps`), never logged, never in results. `exec.ts` passes an explicit `env` (never `process.env`), so Seatbelt's non-scrubbing can't leak host env. Residual (operator's risk, documented): a command could echo its own env to stdout — `allowNet:[]` default blocks exfil.
- **Constraint (keeps the core guard intact):** `validatePolicy` rejects env keys matching `JUNCTION_MASTER_KEY*` (exact) and the heuristic `/_TOKEN$/ /_SECRET$/ /_KEY$/`. So `credentialEnvVar` must NOT end in those suffixes — the schema `.refine` enforces it with a helpful message (use e.g. `GH_PAT`, `API_AUTH`, `…_CRED`). Relaxing the heuristic for one operator-sanctioned key is a **fast-follow** that touches the shared guard → its own security-reviewed increment. Record in `revisit-when.md`; do NOT do it here.

### Required hardening — bound sandbox output (the OOM gap)

`exec.ts` (`spawnSandboxed`) buffers stdout/stderr into **unbounded** `Buffer[]` (`stdoutChunks.push(chunk)`). `timeoutMs` bounds *time* but not *memory* — a flood OOMs junction before the timeout fires. **Add a running output-byte counter; when stdout+stderr exceeds a ceiling (reuse `RESPONSE_BYTE_CAP` = 1 MB), SIGKILL the process group** (same mechanism the timeout uses) and return with the truncated output + a `timedOut`-like/over-cap signal. This is required (the resource-exhaustion mitigation), and it hardens the existing sandbox for every caller, not just this provider. `junction-sandbox-security` must scrutinize it.

### Backend availability — fail closed, list always

- The provider NEVER spawns directly — always `createSandbox().runCommand(argv, policy)`, which already **refuses** (`unsupported-platform`/`runtime-unavailable`) when no Seatbelt/bwrap backend exists. So `callTool` needs no special-casing; on a backend-less host it fails closed by construction. No path raw-execs unsandboxed.
- **`listTools`** returns the operator-declared tools regardless of host backend (matches openapi listing tools when the upstream is down) — `callTool` is where the honest refusal happens.
- **`platform add --kind cli`** probes capabilities; if `command:"none"`, **WARN loudly but allow the add** (the row is portable data; it may be served on a host that has a backend — refusing a data op on current-host capability is wrong). Validate at add: `argv[0]` absolute literal; `credentialEnvVar` shape; cwd ∈ read/write paths; run the descriptor's policies through `validatePolicy` (dry-run) so a secret-dir exposure or metachar is caught at add, not first call.

### Invariants / safety (the checklist this increment must prove)

- **No shell, ever** — argv array to `spawn`, `shell:false` (exec.ts already does this); agent values never interpolated into a string.
- **Agent cannot widen argv** — each segment yields ≤1 element; unknown args rejected.
- **argv[0] absolute**; binary is operator-fixed.
- **FS/net confined by the sandbox**; path-typed args additionally validated (no `..`, within cwd).
- **Secret only in `policy.env[credentialEnvVar]`** — never argv/logs/results; `credentialEnvVar` can't be a `*_TOKEN/_SECRET/_KEY`/`JUNCTION_MASTER_KEY*` name.
- **Output byte-capped** (new) + time-capped (existing) + **fail-closed if no backend**.
- **`~/.junction`/credential dir never exposed** via granted paths (validatePolicy exposure check).
- **`validatePolicy` unchanged** in this increment.
- Clean non-zero exit / timeout / over-cap → `Ok(ToolResult)` with `isError:true` (the command ran, it failed); infra failure (no backend, policy-invalid, spawn error) → `Err(UpstreamError)`, secret-free.

### Proof of done

- `pnpm verify` with tests:
  - **argv building:** each declared arg → exactly one argv element (with prefix); injection values (`"; rm -rf /"`, `"--output=x"`, `"$(whoami)"`, spaces, newlines) are inert single tokens; optional-absent omitted; unknown arg key → `invalid-args`; `type:"path"` rejects `..`/absolute/escape-cwd.
  - **arg validation:** enum/pattern/maxLength/required/type enforced; `additionalProperties:false`.
  - **provider:** `listTools` builds correct JSON-Schemas from `tool.args` (one tool per command); `callTool` maps `SandboxResult` → ToolResult (stdout/stderr/exit, `isError` on nonzero/timeout/over-cap, 1 MB cap); `tool-not-found` for unknown name.
  - **credential-as-env:** secret lands in `policy.env[credentialEnvVar]` ONLY — assert it's absent from argv, from the result text, and from any error (sentinel test); no-secret → env omits it.
  - **refusal:** with capabilities `command:"none"` (mock), `callTool` → `Err` (no raw exec); `listTools` still lists.
  - **exec.ts output cap:** a child flooding stdout is SIGKILLed at the ceiling, output truncated, result flagged — not an OOM (mock a high-output command; assert bounded).
  - **schema/migration:** `CliConnectionSchema` validation (argv[0]-absolute refine, credentialEnvVar refine); migration 0006 additive `cli` column round-trips; `validatePolicy` dry-run at `platform add` rejects a descriptor that exposes `~/.junction` or uses metachars.
- `pnpm build`; `pnpm depcruise` (0 errors — provider in `core`, no new edges); `pnpm quality` (0 clones). SPDX on new files.
- **MANUAL QA (orchestrator) — adversarial:** build a `cli` platform on macOS (Seatbelt) exposing a safe command (e.g. `/bin/echo`, `rg` over a temp dir); `debug probe` shows the tool; `debug call` runs it → real stdout; then drive injection attempts (`; rm`, flag-injection, `../` traversal, a secret echoed only via env) and confirm each is inert/rejected/confined; confirm a path outside readPaths is denied by the sandbox (exit non-zero, not an escape). Note the host backend used.

### Out of scope (record in `docs/futures/`)

Generic `run(commandString)` — **never** (rejection). Deno `runScript`/agent-authored-script tier (larger threat surface). microVM tier (recorded escalation path). Host-scoped network egress (Seatbelt is port-only; host-scoped is Deno/microVM — descriptor may accept host:port but the macOS backend `policy-invalid`s host-scoped; document command-tier net is port-only). Interactive/streaming stdio, agent stdin, array/repeated/env-templated args (v1 = scalar args). The `credentialEnvVar`-name guard refinement (`revisit-when`). A flag-based `platform add` ergonomic builder (v1 = `--json` descriptor).

---

## Part 2 — Implementation

### Step 1 — core schema + migration
- New `core/src/schema/cli-connection.ts` (SPDX, data-only): `CliConnectionSchema` per the research design — `CliArgSchema` (name/description/type∈{string,number,boolean,enum,path}/required/enum/pattern/maxLength≤4096), `CliArgvSegmentSchema` (discriminated `literal`/`arg`), `CliPolicySchema` (cwd absolute, readPaths/writePaths/allowNet/timeoutMs≤600_000/envAllow), `CliToolSchema` (name `^[a-z][a-z0-9_]*$`, description, argv `.min(1)` with `.refine` argv[0] literal+absolute, args, policy), `CliConnectionSchema` (tools `.min(1)`, `credentialEnvVar` regex + `.refine` not `*_TOKEN/_SECRET/_KEY`). Export type.
- `core/src/schema/platform.ts`: add `cli: CliConnectionSchema.optional()`.
- `core/src/db/schema.ts`: add `cli: text("cli")` (additive). **Migration 0006 via `pnpm drizzle-kit generate`** (ADD COLUMN; snapshot + journal — never hand-author). `repositories/platforms.ts`: serialize/Zod-validate `cli` like the `openapi`/`graphql` columns. `core/src/index.ts`: export schema + type.

### Step 2 — the provider (core module)
New `core/src/sources/cli/provider.ts` — `createCliProvider(connection: CliConnection, secret: string | null): ToolProvider` (no external deps; uses `createSandbox`, `validatePolicy` helpers via runCommand, Zod). `listTools` → one `ProviderTool` per `connection.tools` (build inputSchema from `tool.args`). `callTool(rawName, args)` per the algorithm below. `close()` no-op. Keep arg-validation + argv-building in small pure helpers (e.g. `core/src/sources/cli/args.ts`, `argv.ts`) — single-purpose, unit-testable.

**callTool algorithm:**
1. `tool = byName.get(rawName)`; absent → `tool-not-found`.
2. Validate `args` against a strict schema derived from `tool.args` (types, enum, `pattern`→anchored RegExp, maxLength, required, `additionalProperties:false`); failure → `invalid-args` (reason carries NO secret). `type:"path"`: relative + no `..` + joins within cwd.
3. Build argv from `tool.argv` (literal → value; arg → one element `(prefix??"")+String(value)`; omit optional-absent).
4. Build policy: `{ cwd, readPaths:[...new Set([cwd, ...tool.policy.readPaths])], writePaths, allowNet, timeoutMs, env: secret && connection.credentialEnvVar ? {...envAllow, [credentialEnvVar]: secret} : {...envAllow} }`.
5. `createSandbox().andThen(s => s.runCommand(argv, policy))` — sandbox runs `validatePolicy` (metachar/exposure/secret-denylist) + refuses if no backend.
6. Map: `Ok(SandboxResult)` → `ToolResult` (byte-capped text `exit <code>[ , timed out]` + stdout + stderr; `isError = exitCode!==0 || timedOut`). `Err(SandboxError)` → `UpstreamError` (policy-invalid/unsupported-platform/runtime-unavailable → connect-failed/call-failed; timed-out → `{kind:"timed-out",ms}`; spawn-failed → call-failed) — secret-free.

### Step 3 — harden `exec.ts` (output byte-cap)
In `core/src/sandbox/exec.ts spawnSandboxed`: track `outBytes += chunk.length` across stdout+stderr; when it exceeds `RESPONSE_BYTE_CAP` (import/define 1 MB), SIGKILL the process group (mirror the timeout path: `process.kill(-child.pid,"SIGKILL")` with the wrapper fallback), stop buffering, and resolve with the truncated output + an over-cap flag (surface via `timedOut`-style or a new `SandboxResult` field — prefer reusing the existing shape; if a flag is needed keep it minimal and update all backends/tests). Must not change the success path for normal-size output. This is shared sandbox code — every backend benefits.

### Step 4 — wiring
- `cli/src/providers.ts buildProvider`: add `if (platform.kind === "cli") { if (!platform.cli) return errAsync(connect-failed); return ok(createCliProvider(platform.cli, secret)) }`.
- `cli/src/commands/platform.ts`: `add --kind cli` — read the descriptor from a `--descriptor`/`--json-file` or the `JSON_ARG` headless blob (the descriptor is too rich for flags); Zod-parse `CliConnectionSchema`; probe `createSandbox().capabilities()` → if `command:"none"` warn (allow add); dry-run each tool's policy through `validatePolicy` (catch exposure/metachar at add); persist. `--json`.
- No `tsconfig.depcruise`/`vitest` alias changes (provider is in core, already aliased).

### Step 5 — tests + skill + futures
Tests per Proof-of-done (argv-building + injection-inert is the priority suite; the exec.ts cap; the credential-as-env sentinel; the refusal path). `junction-dev` skill: `platform add --kind cli` with an example descriptor; the security posture (operator-fixed, no shell). `docs/futures/revisit-when.md`: credentialEnvVar-name guard refinement (trigger: operators want `GITHUB_TOKEN`) + command-tier port-only egress (trigger: host-scoped net needed → Deno/microVM). `docs/futures/gotchas.md`: the exec.ts output-cap (why unbounded buffering was a latent OOM).

### Step 6 — verify, build, commit
`pnpm verify` + `pnpm quality` + `pnpm depcruise` + `pnpm build` (migration 0006 + snapshot in dist). SPDX. Commit; push; PR base main.

---

## Review (background, after build)

- **`junction-sandbox-security`** (LEAD — activating increment): no agent input reaches a shell or widens argv; argv[0] absolute; the `exec.ts` output-cap SIGKILLs correctly and doesn't regress the timeout/process-group logic; `validatePolicy` is UNCHANGED and actually gates this provider (metachar + secret-dir exposure); the secret lives only in `policy.env`; fail-closed on no backend; path-arg traversal blocked.
- **`ce-security-reviewer`**: adversarial — construct argv/arg-injection, path traversal, secret-exfil, resource-exhaustion attempts and confirm each is defeated.
- **`ce-correctness-reviewer`**: arg validation + argv building exhaustive over the arg types; result/error mapping (ran-but-failed = Ok+isError vs infra = Err); optional-arg omission; multi-tool dispatch.
- **`junction-package-boundary` + `junction-clean-code-reviewer`**: provider correctly in `core` (no new package, no external dep, no new edge); single-purpose helpers; typed errors; SPDX; thin cli edge; the exec.ts change stays minimal.
- **`ce-data-migration-reviewer`**: migration 0006 additive, snapshot present, round-trips.
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)
**Visually testable — YES:** add a `cli` platform (e.g. `/bin/echo` or `rg` over a temp dir), `debug probe` shows the tool(s), `debug call` runs it → real stdout; injection/traversal attempts are inert/confined; a secret reaches the process only via its env var. **QA'd by me:** drove a real Seatbelt-sandboxed command end-to-end + adversarial attempts (shell-meta, flag-injection, path-traversal, secret-in-env-only, output-flood capped, no-backend refusal). **Checklist:** operator-fixed named commands (no `run`), argv segments (≤1 element each, shell:false), argv[0] absolute, per-arg validation (enum/pattern/maxLength/path-no-traversal), secret only in policy.env (name-guarded), exec.ts output byte-cap, fail-closed on no backend, ~/.junction never exposed, validatePolicy unchanged, additive migration 0006.

## User test gate
```bash
pnpm build
JUNCTION_HOME=/tmp/jt21 node packages/cli/dist/index.js init
# a minimal cli descriptor (echo) — adjust the absolute binary path for your OS:
cat > /tmp/echo-cli.json <<'JSON'
{ "tools": [ {
  "name": "echo", "description": "Echo a message",
  "argv": [ {"kind":"literal","value":"/bin/echo"}, {"kind":"literal","value":"--"}, {"kind":"arg","name":"message"} ],
  "args": [ {"name":"message","type":"string","required":true,"maxLength":200} ],
  "policy": { "cwd":"/tmp", "readPaths":["/tmp"], "writePaths":[], "allowNet":[], "timeoutMs":5000, "envAllow":{} }
} ] }
JSON
JUNCTION_HOME=/tmp/jt21 node packages/cli/dist/index.js platform add --id local-cli --kind cli --display-name "Local CLI" --descriptor "$(cat /tmp/echo-cli.json)"
JUNCTION_HOME=/tmp/jt21 node packages/cli/dist/index.js debug probe --platform local-cli
JUNCTION_HOME=/tmp/jt21 node packages/cli/dist/index.js debug call --platform local-cli --tool echo --args '{"message":"hello; rm -rf /"}'   # the "; rm" is an inert literal
```
Approve → next: Web UI, then OAuth.
