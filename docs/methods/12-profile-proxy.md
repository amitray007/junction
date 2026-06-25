# Method File 12 — Profile proxy: agent calls a real tool through junction (Wedge increment C)

> **The wedge fully landed.** Wire it so an agent pointed at a junction **profile endpoint** (`junction mcp serve --profile <name>`) sees the profile's sources' tools **namespaced** (`github_work__list_issues`) and can **actually call them** — junction proxies each call to the upstream MCP source (via `mcp/client`), injecting the credential, returning the result. The **credential never reaches the agent**. Source-agnostic; GitHub is just a configured source.
>
> **Builder:** Sonnet, with care (a credential-at-call-time + multi-source proxy path). **No boundary refinement needed** — `mcp/server` takes *injected* tool-handlers (stays a thin SDK wrapper); the **cli** wires `mcp/client`'s proxy in. `mcp/server → mcp/client` is deliberately avoided.

---

## Part 1 — Spec (what & why)

### Goal

Turn the per-profile MCP endpoint (inc 7 shell) into a real proxy: list + call the profile's sources' tools, end to end. Realizes the wedge (idea.md Moment #2 — connect once, any agent reaches it). Proof: `junction mcp serve --profile work` advertises `<namespace>__<tool>` for each enabled SourceRef, and a `tools/call` is proxied to the upstream and returns its result — with the token nowhere in the agent-facing traffic.

### Prerequisite — `junction profile create` (small; required to be testable)

Only `profile list` + `profile add-source` exist; `add-source` needs an existing profile, and none can be created via CLI. Add `junction profile create --name <name> [--json]` → creates an empty Profile (`profilesRepo.create`, with `mcpEndpointPath = deriveMcpEndpointPath(name)`). Now: `profile create` → `profile add-source` → `mcp serve --profile` is a full flow.

### Architecture — injection (no `mcp/server → mcp/client` edge)

- **`mcp/client` (owns the multi-source proxy logic — it's upstream-consumption):** add `createProfileProxy(sources, resolveSource): ProfileProxy` returning `{ listTools(): ResultAsync<NamespacedTool[], …>, callTool(name, args): ResultAsync<ToolResult, UpstreamError> }`.
  - `resolveSource(sourceRef): ResultAsync<{ connection: McpConnection; secret: string|null; toolNamespace: string; toolFilter? }, …>` — **injected** (the cli builds it from repos + CredentialStore; `mcp/client` never imports the store).
  - `listTools`: for each **enabled** SourceRef → `resolveSource` → `connectSource` (inc-11) → `listTools` (already namespaced + per-tool-skip) → apply the source's `toolFilter` (allow/deny) → aggregate → **close each session**. **Per-source resilience:** a source that fails to resolve/connect/list is **skipped** (collect a warning), NEVER aborts the whole catalog (one dead source ≠ dead profile).
  - `callTool(name, args)`: split on first `__` → find the SourceRef whose `toolNamespace` matches (else `tool-not-found`) → `resolveSource` → `connectSource` → `callTool` (stripped) → return → **close**. Lifecycle **v1: connect-per-call + close** (note warm-session pooling as a `docs/futures` trigger; don't build).
- **`mcp/server` (stays a thin SDK wrapper — injected handlers, NO mcp/client import):** `createMcpServer(profile, handlers)` where `handlers = { listTools(): Promise<{tools}>, callTool(name, args): Promise<CallToolResult> }`. The `ListToolsRequestSchema` handler delegates to `handlers.listTools()`; **add a `CallToolRequestSchema` handler** that delegates to `handlers.callTool(req.name, req.arguments)` and maps an `UpstreamError`/Err to a proper MCP error (or a `CallToolResult` with `isError:true`). `mcp/server → core` only — unchanged boundary.
- **cli (`mcp serve` — the composition root that wires it):** load the Profile (with its sources) + open the DB/repos + `createCredentialStore`; build `resolveSource` (closes over repos + store: SourceRef → Platform.connection + `CredentialStore.get(credential.secretRef)` + namespace + toolFilter); `const proxy = createProfileProxy(profile.sources, resolveSource)` (mcp/client); adapt `proxy` → the `{listTools, callTool}` shape `createMcpServer` wants (mcp/server); serve over stdio. Edge stays thin (wiring only).

### The credential-never-leaves invariant (security-critical)

- The secret is resolved **fresh per call/list** inside junction's process (`CredentialStore.get`), injected into the `mcp/client` transport (header/env), and **never** returned to the agent, logged, or placed in a tool result/error. Tool **results** come from the upstream (data), not secrets. The agent talks only to junction's per-profile server; it never sees a token. (Re-uses inc-11's verified injection discipline.)
- **Per-profile isolation:** the server only ever resolves/serves ITS profile's sources.

### Proof of done

- `pnpm verify` with tests (in-memory; no network/CI spawn):
  - **End-to-end proxy:** an in-memory upstream MCP **server** (InMemoryTransport) with 2 tools; a Profile with one SourceRef (`toolNamespace: "src"`) + a `resolveSource` that returns an in-memory `connectSource`-equivalent; a `Client` connects to `createMcpServer(profile, proxyHandlers)`; `listTools()` → `src__<tool>` for both; `callTool("src__<tool>", args)` → the upstream result. (Factor so the in-memory upstream substitutes for a real transport.)
  - **Multi-source namespacing:** two sources (`work`, `personal`) → `work__x` + `personal__x` both listed, calls route to the right one.
  - **Per-source resilience:** one source whose `resolveSource`/connect fails → its tools are skipped, the OTHER source's tools still list; a call to the dead namespace → `tool-not-found`/clean error (no crash).
  - **toolFilter:** a source with `allow`/`deny` → only the allowed tools surface.
  - **Credential discipline:** a sentinel secret in `resolveSource` → assert it appears in NO listTools/callTool result, NO MCP response, NO error/log.
  - **`profile create`** → empty profile persisted; `create`+`add-source`+list round-trips.
  - **`mcp serve` CallTool wiring** (unit/child-process): the server's CallTool handler routes through the proxy.
- `pnpm build`; `pnpm depcruise` clean — **mcp/server → core only (NOT mcp/client)**, **mcp/client → core only**, **cli → core/mcp-server/mcp-client** (app→lib) — do NOT edit `.dependency-cruiser.cjs` (the injection design needs no change; if depcruise flags an edge, you wired it wrong — report). `pnpm quality`. SPDX; CI green.
- **MANUAL QA (orchestrator):** `junction profile create` + `add-source` (a working local **stdio** MCP source) + pipe an MCP `initialize`+`tools/list`+`tools/call` into `junction mcp serve --profile <name>` → see `<ns>__<tool>` and a real proxied result. (GitHub's remote MCP is allowlist-gated → its call returns `auth-failed`; the proxy path itself is proven via the local source + the namespaced listing.)

### Out of scope (Wedge D+)

- Guided `junction connect` UX (D). OAuth (E). Warm-session pooling / connection reuse (futures). Audit logging (§13). Streamable-HTTP serving (stdio only). The `mcp/server → mcp/client` edge (avoided by injection).

---

## Part 2 — Implementation

### Step 1 — `profile create`

`commands/profile.ts`: add a `create` subcommand (`--name`, `--json`) → `profilesRepo.create({ id: ProfileId(name), name, sources: [], mcpEndpointPath: deriveMcpEndpointPath(name) })`; register under `profile`. Validate name via `ProfileNameSchema`. (Confirm `profilesRepo.create` accepts an empty-sources profile.)

### Step 2 — `mcp/client` profile proxy

`packages/mcp/client/src/proxy.ts`: `createProfileProxy(sources, resolveSource)` per §architecture — `listTools` (resolve→connect→list→toolFilter→aggregate→close, per-source skip on failure) + `callTool` (split→match namespace→resolve→connect→call→close). Reuse `connectSource`, `splitNamespacedName`, the `UpstreamError` taxonomy. Export from the barrel. Pure-injectable `resolveSource` (no CredentialStore import in mcp/client). Apply `toolFilter` (allow wins → only allow; deny → exclude).

### Step 3 — `mcp/server` injected handlers + CallTool

`packages/mcp/server/src/server.ts`: change `createMcpServer(profile, handlers)`; ListTools delegates to `handlers.listTools()`; **add** `setRequestHandler(CallToolRequestSchema, …)` delegating to `handlers.callTool(name, arguments)`, mapping a returned Err/UpstreamError to a `CallToolResult{ isError:true, content:[…] }` (no secret in the message) or an MCP error. Keep `deriveToolsFromProfile` removed/replaced — tools now come from the injected handler. `mcp/server` imports `core` + MCP SDK only.

### Step 4 — cli `mcp serve` wiring

`commands/mcp.ts`: after loading the Profile, open repos + `createCredentialStore`; build `resolveSource(sourceRef)` = look up Platform (its `connection`) + `credentialsRepo.get(sourceRef.credentialId)` + `CredentialStore.get(cred.secretRef)` → `{connection, secret, toolNamespace, toolFilter}` (ResultAsync, typed errors; a source missing its platform/credential → skipped with a stderr note, never stdout). `createProfileProxy(profile.sources, resolveSource)` → adapt to `{listTools, callTool}` → `createMcpServer(profile, handlers)` → `serveStdio`. **stdout stays MCP-only** (inc-7 invariant; resolver/proxy errors → stderr). Lazy-import mcp/client + mcp/server.

### Step 5 — tests + docs

Per Proof-of-done (in-memory end-to-end, multi-source, per-source resilience, toolFilter, sentinel credential discipline, profile create, CallTool wiring). Record the **connect-per-call → warm-pool** optimization trigger in `docs/futures/revisit-when.md`. Update `.claude/skills/junction-dev` with `profile create` + the full `serve` flow.

### Step 6 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` (clean, **no new boundary edges**) + `pnpm build`. SPDX. Commit; push; PR base main: "feat: profile proxy — agent calls a real tool through a junction profile (wedge C / increment 12)".

---

## Review (background, after build)

- **`junction-mcp-contract`** (the proxy is the core contract now): per-profile aggregation, `<ns>__<tool>` end-to-end, CallTool routing (split→match→strip→upstream), per-source resilience (one dead source ≠ dead profile), **no credential in any agent-facing response/result/error**, stdout-MCP-only in serve.
- **`junction-credential-security`** (credential-at-call-time across the full proxy): secret resolved per-call, injected only into the transport, NEVER in a tool result / MCP response / error / log; per-profile isolation.
- **`junction-package-boundary`** (verify the injection kept it clean): `mcp/server → core` only (NOT mcp/client), `mcp/client → core` only, `cli → all libs`. No `.dependency-cruiser.cjs` change.
- Junction `junction-clean-code-reviewer` (thin serve edge, Result discipline). CE: `ce-correctness-reviewer` (routing, resolve/connect/close lifecycle, error mapping), `ce-reliability-reviewer` (per-call connect/close, no leaked session/process across the proxy, one-source-fails handling), `ce-security-reviewer`, `ce-testing-reviewer`.
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** `junction profile create` + `add-source` (a local stdio MCP source) + pipe an MCP handshake into `junction mcp serve --profile <name>` → see `<ns>__<tool>` and a real proxied tool result (the wedge, end to end). **QA'd by me:** drove the full flow against a local stdio source; confirmed namespaced listing + a proxied call result; confirmed the token appears in no agent-facing traffic; per-source resilience (a bad source doesn't kill the profile); reviews addressed. **Checklist:** profile create, per-profile proxy (resolve→connect→list/call→close), `<ns>__<tool>` end-to-end + CallTool routing, per-source skip, toolFilter applied, credential-never-leaves, stdout-MCP-only, injection (no mcp/server→mcp/client edge), source-agnostic.

## User test gate

`pnpm build`, then (a real working source — local stdio shown; or your GitHub, which will proxy-list but `auth-failed` on call since GitHub's remote MCP is gated):
```bash
JUNCTION_HOME=/tmp/jt12 node packages/cli/dist/index.js init
JUNCTION_HOME=/tmp/jt12 node packages/cli/dist/index.js profile create --name work
# ... platform add + credential add (a working MCP source) + profile add-source --profile work --platform <id> --credential <id> --namespace src ...
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | JUNCTION_HOME=/tmp/jt12 node packages/cli/dist/index.js mcp serve --profile work
# → tools/list returns src__<tool> names proxied from the upstream
```
Approve → Wedge D (guided `junction connect` UX) — or, since the wedge now works end-to-end, we discuss what's most valuable next (OAuth, the web UI, audit, more source types).
