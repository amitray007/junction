# Method File 11 — `@junction/mcp-client`: generic upstream connector (Wedge increment B)

> **The centerpiece — and the riskiest increment.** Fills the reserved `@junction/mcp-client` stub: a **generic** connector that connects to *any* MCP source (remote HTTP **or** local stdio — from the `Platform.connection` descriptor built in Wedge A), **injects the resolved credential** (bearer header / env), lists the upstream tools **namespaced** (`<toolNamespace>__<tool>`), and routes `callTool` back (strip the namespace) — with the **token never reaching the agent or any log**. Source-agnostic: zero vendor code. A `junction debug mcp-probe` command makes it testable in isolation — including against the **real GitHub remote MCP already set up in `/tmp/jt10`**.
>
> **Builder:** Sonnet, **maximum care** — this spawns/connects to upstream, injects secrets, and is the first outbound-network/credential-at-call-time path. **No proxying through `mcp/server` yet** (that's Wedge C, which adds the `mcp/server → mcp/client` edge + its boundary refinement).

---

## Part 1 — Spec (what & why)

### Goal

Make junction able to *connect to* a configured MCP source and enumerate/relay its tools, generically, with the credential injected at the transport and never exposed. Realizes the "any source" half of the wedge (idea.md §1). Proof: `junction debug mcp-probe --platform github --credential <id>` (against `/tmp/jt10`) connects to GitHub's remote MCP with the stored token and prints the **namespaced** tool list — the token appearing nowhere in output/logs.

### Source-agnostic (still load-bearing)

`@junction/mcp-client` knows **transports**, not vendors. It takes a generic `McpConnection` (Wedge A's descriptor) + an already-resolved secret string and connects. No `if (platform === "github")`, no hardcoded URLs/tools. GitHub is just the descriptor it's handed.

### Interface (Result-returning; in `@junction/mcp-client`, depends on `core` + MCP SDK)

```ts
// the resolved secret is INJECTED by the caller — mcp-client never touches CredentialStore (clean, testable)
export interface UpstreamSession {
  /** Upstream tools, each name prefixed with `<namespace>__`. */
  listTools(): ResultAsync<NamespacedTool[], UpstreamError>
  /** Call a `<namespace>__<tool>` — strips the prefix, routes upstream. */
  callTool(name: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError>
  close(): Promise<void>
}
export function connectSource(
  connection: McpConnection,      // Wedge A: {transport:"http",url,auth?} | {transport:"stdio",command,args,tokenEnvVar?}
  toolNamespace: string,          // e.g. "github_work" — for prefixing
  secret: string | null,          // resolved plaintext (or null if the source needs none); injected, never logged
): ResultAsync<UpstreamSession, UpstreamError>
```
`UpstreamError` (add to `core/src/errors/index.ts`, a discriminated union like the others):
`| { kind:"binary-not-found"; command } | { kind:"connect-failed"; cause } | { kind:"auth-failed"; cause? } | { kind:"upstream-unavailable"; cause } | { kind:"tool-not-found"; name } | { kind:"call-failed"; cause } | { kind:"namespace-too-long"; name } | { kind:"timed-out"; ms }`.

### Verified transport construction (MCP SDK 1.29 — don't deviate)

- **http** (the `/tmp/jt10` GitHub path, PRIMARY): `new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { [connection.auth.header ?? "Authorization"]: \`Bearer ${secret}\` } } })`. Only when `connection.auth?.scheme === "bearer"` and a secret is present; otherwise no auth header.
- **stdio** (generic local binaries): `new StdioClientTransport({ command, args, env: { ...getDefaultEnvironment(), ...(tokenEnvVar && secret ? { [tokenEnvVar]: secret } : {}) } })`.
  > **VERIFIED GOTCHA (record in `docs/futures/gotchas.md`):** a custom `env` **replaces** the default — omit `PATH`/`HOME` and the spawn fails. ALWAYS spread `getDefaultEnvironment()` (returns HOME,LOGNAME,PATH,SHELL,TERM,USER) first, then the token. This also keeps the child env minimal (no `process.env` spill — matches the sandbox env-scrub discipline). Resolve a bare `command` not-found → `binary-not-found` (don't crash).
- **Client:** `new Client({ name:"junction", version }); await client.connect(transport)`. `listTools()` → `callTool({name, arguments})` → `close()`.

### Namespacing (the load-bearing proxy logic)

- **listTools:** prefix every upstream tool name → `core.namespacedTool(toolNamespace, upstreamName)` (the existing `<ns>__<tool>` helper). **VALIDATE the prefixed length ≤ 64** (MCP tool-name limit `^[a-zA-Z0-9_-]{1,64}$`); if a prefixed name would exceed 64 → `namespace-too-long` error (NEVER silently truncate — truncation breaks routing). Pass through each tool's `description`/`inputSchema` unchanged.
- **callTool:** split the incoming name on the **first** `__`; the prefix must match this session's `toolNamespace` (else `tool-not-found`); call the **stripped** name upstream.
- Ignore the upstream's `instructions`/server capabilities (junction advertises its own surface).

### Credential discipline (security-critical)

- The secret is **injected only** into the transport (header / env) — never into argv (visible in `ps`), tool arguments, results, logs, or an `UpstreamError.cause`. The caller resolves it from `CredentialStore` and passes it; `mcp-client` holds it only for the transport construction.
- **Per-(source) session** — one `UpstreamSession` per connect; never shared across profiles/sources (mirrors the per-profile `Server` rule).
- **Lifecycle v1: lazy connect-per-use + close** (no pooling — note the warm-pool optimization as a `docs/futures/revisit-when` trigger; don't build it). Wrap `callTool`/`connect` in a **timeout** → `timed-out`.
- **No sandbox around the upstream for v1** (http fetch / first-party trust). **Record the trigger** (`docs/futures/revisit-when.md`): when junction spawns a *third-party/untrusted* MCP binary (stdio), route its spawn through the inc-8 sandbox.

### The testable surface — `junction debug mcp-probe`

A debug command (under a `debug` namespace; clearly non-production): `junction debug mcp-probe --platform <id> --credential <id> [--json]`. It: loads the Platform (must have a `connection`), resolves the Credential's secret via `CredentialStore`, calls `connectSource`, `listTools`, prints the **namespaced tool names + count** (NEVER the token, NEVER secret-bearing output), `close()`. Honest errors via the `UpstreamError` formatter. This is how we test Wedge B in isolation — and against the real `/tmp/jt10` GitHub setup.

### Proof of done

- `pnpm verify` with tests (no network in CI):
  - **In-memory round-trip:** stand up a tiny in-memory MCP **server** (the SDK's `InMemoryTransport.createLinkedPair()` ↔ a `Client`) exposing 2 fake tools; wrap the client side in `connectSource`-equivalent logic; assert `listTools()` returns them **prefixed** `ns__tool`; `callTool("ns__tool", args)` routes to the **stripped** name and returns the result; an unknown prefix → `tool-not-found`; a too-long namespace → `namespace-too-long`. (If `connectSource` is transport-coupled, factor the namespacing into a pure `namespaceTools`/`routeCall` unit tested directly + a thin transport wrapper.)
  - **Transport construction:** http builds the bearer header from `connection.auth.header`; stdio spreads `getDefaultEnvironment()` + injects `tokenEnvVar` (assert PATH present, token present, no `process.env` spill); missing stdio command → `binary-not-found`.
  - **Credential discipline:** a connect/list/call sequence with a sentinel secret → assert the sentinel appears in NO log/stdout/`UpstreamError`/tool-arg (serialize the error + result, grep).
  - **Timeout:** a hanging upstream → `timed-out`.
  - **debug mcp-probe** (unit, mocked connectSource): prints namespaced names + count, never the token; errors formatted.
- `pnpm build`; `pnpm depcruise` clean (**cli → mcp/client** is an allowed app→lib edge; **mcp/client → core** only; mcp/client does NOT import mcp/server; MCP SDK external) — do NOT edit `.dependency-cruiser.cjs`. `pnpm quality`. SPDX; committed; CI green.
- **MANUAL QA (orchestrator, against `/tmp/jt10`):** `junction debug mcp-probe --platform github --credential <id>` connects to GitHub's remote MCP and lists `github_work__*` tools (or, if GitHub's remote MCP is allowlist-gated and 401s, the error surfaces as `auth-failed`/`upstream-unavailable` — and we validate the generic path against another MCP source). Token absent from all output.

### Out of scope (Wedge C+)

- **No `mcp/server` proxying / `deriveToolsFromProfile` wiring** — that's Wedge C (introduces `mcp/server → mcp/client`, needs the layered boundary refinement + matrix). No profile-level multi-source aggregation yet (B connects one source). No connection pooling/warm sessions. No guided `connect` UX (Wedge D). No OAuth (E). No sandboxing the upstream (recorded trigger).

---

## Part 2 — Implementation

### Step 1 — package + deps

`packages/mcp/client/package.json`: add `@modelcontextprotocol/sdk@^1.29` + `@junction/core` (workspace). `tsconfig.json`: reference `../../core` (note depth). tsdown build + config (mirror mcp/server). Replace the `PLACEHOLDER`.

### Step 2 — `UpstreamError` + namespacing primitives

Add `UpstreamError` to `core/src/errors/index.ts`. In mcp/client: pure helpers `namespaceToolName(ns, name)` (+ ≤64 guard) and `splitNamespacedName(name)` (first `__`) — unit-testable without a transport.

### Step 3 — `connectSource` + `UpstreamSession`

`packages/mcp/client/src/`: `connect.ts` builds the transport from the `McpConnection` discriminant (http/stdio per the verified construction; `getDefaultEnvironment()` spread for stdio), connects the `Client`, returns an `UpstreamSession` whose `listTools` namespaces + length-guards, `callTool` splits/validates/strips/routes (timeout-wrapped), `close` closes the client/transport. All `ResultAsync<…, UpstreamError>`; map SDK throws (connect refused, 401, timeout, ENOENT) to the right `UpstreamError` kind. Secret only in the transport; never logged/in errors. Narrow barrel `index.ts`.

### Step 4 — `debug mcp-probe` CLI

`packages/cli/src/commands/debug.ts` — `debug` command with `mcp-probe` subcommand (`--platform`, `--credential`, `--json`). Load Platform (error if no `connection`), `createCredentialStore` + `get(secretRef)`, `connectSource`, `listTools`, print namespaced names + count (NEVER the token), `close` in a `finally`. Register `debug` in the citty root. Thin edge → mcp/client + core. Format `UpstreamError` exhaustively. `cli → @junction/mcp-client` (allowed app→lib).

### Step 5 — tests + docs

Per Proof-of-done (in-memory round-trip, transport construction, credential-discipline sentinel, timeout, probe). Record the **env-merge gotcha** in `docs/futures/gotchas.md` and the **warm-pool** + **sandbox-third-party-binary** triggers in `docs/futures/revisit-when.md`. Update `.claude/skills/junction-dev` with `debug mcp-probe`.

### Step 6 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` (clean) + `pnpm build`. SPDX. Commit; push; PR base main: "feat: @junction/mcp-client — generic upstream MCP connector + debug probe (wedge B / increment 11)".

---

## Review (background, after build)

- **`junction-mcp-contract`** (re-activate): namespacing correctness (`<ns>__<tool>`, ≤64 guard, first-`__` split routing); per-source session isolation; transport correctness (http bearer / stdio env-merge); **no credential leakage** (token only in transport, never in args/results/logs/errors); ignores upstream instructions.
- **`junction-credential-security`** (re-activate — secret-at-call-time): the resolved secret is injected only into the transport, never argv/log/error/result; held only transiently; the probe never prints it.
- Junction: `junction-package-boundary` (cli→mcp/client allowed; mcp/client→core only, NOT →mcp/server; SDK external — no boundary edit), `junction-clean-code-reviewer`. **Source-agnostic grep** (no vendor code).
- CE: `ce-correctness-reviewer` (the namespace split/route, SDK-error→UpstreamError mapping, lifecycle/close, timeout), `ce-reliability-reviewer` (connect/close lifecycle, no hung process, timeout), `ce-security-reviewer` (injection/leak, env-merge minimal env, argv exposure), `ce-testing-reviewer` (the in-memory round-trip + sentinel coverage).
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** `junction debug mcp-probe --platform github --credential <id>` against `/tmp/jt10` lists the namespaced GitHub tools (token never shown); plus the in-memory tests. **QA'd by me:** ran the probe against the real `/tmp/jt10` GitHub source (or surfaced an honest `auth-failed` if allowlist-gated + validated the generic path another way); confirmed the token appears in no output/log/error; namespacing + routing correct; reviews addressed. **Checklist:** generic transport (http+stdio, no vendor code), bearer/env credential injection (token only in transport), `<ns>__<tool>` namespacing + ≤64 guard + first-`__` routing, UpstreamError mapping, timeout, per-source session, env-merge gotcha handled, debug-probe token-safe.

## User test gate

`pnpm build`, then against your existing setup:
```bash
JUNCTION_HOME=/tmp/jt10 node packages/cli/dist/index.js credential list --platform github --json   # pick a credential id
JUNCTION_HOME=/tmp/jt10 node packages/cli/dist/index.js debug mcp-probe --platform github --credential <id>
# → connects to GitHub's remote MCP with your token, prints github_work__<tool> names (token never shown)
```
(If GitHub's remote MCP is allowlist-gated for your account, you'll see a clean `auth-failed`/`upstream-unavailable` — the generic connector still works; we can point it at any MCP server.) Approve → Wedge C: wire `deriveToolsFromProfile` so an agent pointed at your profile actually *calls* `github_work__list_issues`.
