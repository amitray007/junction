# Method File 07 — mcp/server Shell (Increment 7)

> **junction starts speaking MCP.** Fills the `@junction/mcp-server` package: a `createMcpServer(profile)` that builds an `McpServer` (zero tools yet) over the MCP SDK, served on **stdio**, plus a `junction mcp serve` command so you can point an MCP client (Claude Desktop, etc.) at junction and watch it connect with an (empty) tool list. The `junction-mcp-contract` reviewer (stubbed since inc 0) **ACTIVATES**.
>
> **Builder:** Sonnet. **One careful architectural change:** this introduces the first `cli → mcp-server` edge, which requires refining the depcruise boundary rule (app-vs-lib). Treat that like the inc-3 subpath fix — implement AND verify a test matrix; do not over-loosen.

---

## Part 1 — Spec (what & why)

### Goal

Wire `@junction/mcp-server` to the MCP SDK and make junction serve an MCP endpoint per Profile (zero tools registered yet — the shell). Realizes design spec §6 increment 7 + the load-bearing conventions (per-profile endpoints, `<namespace>__<tool>` — encoded now so renaming later can't happen). Proof: an MCP client connects to a profile's server and `tools/list` returns empty; `junction mcp serve` speaks MCP over stdio.

### Decided design

- **SDK:** `@modelcontextprotocol/sdk@^1.29` (verified API: `McpServer` from `…/server/mcp.js`, `StdioServerTransport` from `…/server/stdio.js`, `Client` + `InMemoryTransport.createLinkedPair()` from the client/inMemory entries).
- **`createMcpServer(profile: Profile): Server`** — builds a per-profile MCP server that **advertises the `tools` capability and serves a profile-driven tool list (empty now)**. The per-profile model lives here: each Profile → its own server (per-profile endpoints, NOT a shared server filtered per call — design spec §4).

  > **VERIFIED GOTCHA (prototyped against SDK 1.29 — don't hit this wall):** a high-level `McpServer` with **zero** `registerTool` calls does **NOT** advertise the `tools` capability, so a client's `tools/list` throws `-32601 Method not found` (NOT an empty list). Passing `capabilities:{tools:{}}` to `McpServer` does **not** fix it. The clean, verified solution (junction is a tool broker — it should ALWAYS answer "what tools do you have?" with a list, empty or not): use the **low-level `Server`** (`@modelcontextprotocol/sdk/server/index.js`) with `{ capabilities: { tools: {} } }` and an explicit `setRequestHandler(ListToolsRequestSchema, async () => ({ tools: deriveToolsFromProfile(profile) }))` — which returns `[]` now and the profile's `<namespace>__<tool>` tools later. This is the right model for junction (profile-driven tool list), not a workaround. (This refines the spec ADR's "McpServer" to the same SDK's lower-level `Server` API for an always-present, profile-driven tools list.)
  - `deriveToolsFromProfile(profile)` returns `[]` this increment (zero sources/tools). Document (in code) that future tools MUST be `<namespace>__<tool>` via `core`'s `namespacedTool` + the SourceRef's `toolNamespace` — so the convention is wired even though no tool exists yet.
- **Transport: stdio only** (`StdioServerTransport`). The local child-process model an agent spawns. **No SSE** (deprecated). Streamable HTTP + the long-running daemon are deferred (design spec §2). So no Origin/DNS-rebinding concerns this increment (those are HTTP-transport concerns).
- **`serveStdio(profile): Promise<void>`** (or Result) — `server.connect(new StdioServerTransport())`. The process then speaks MCP over stdin/stdout until closed.
- **No credentials touched.** Zero tools ⇒ no sources ⇒ no secret access. The credential store (inc 6) engages only when real tools/sources connect (post-foundation). Keep this increment free of any credential path.

### CLI surface — `junction mcp serve [--profile <name>]`

- A `mcp` command with a `serve` subcommand. Loads the named Profile from the DB (inc 5 `profilesRepo`); if `--profile` is omitted OR no profile exists yet, serve a **synthetic default profile** (`name: "default"`, no sources) so it works before any profiles are created (none can be created via CLI yet — that's post-foundation). Runs `serveStdio`.
- This command's stdout/stdin ARE the MCP channel — so it must emit **nothing else** on stdout (no consola/log noise; human messages, if any, go to stderr). This is load-bearing: a stray stdout line corrupts the MCP stream.
- Register `mcp` in the citty root. Edge stays thin: the command loads the profile via core, calls `mcp-server`, nothing more.

### The boundary refinement (app-vs-lib) — careful, verified

The current depcruise `no-cross-edge-imports` rule forbids cli/web/mcp from importing each other (symmetric peers). But `junction mcp serve` legitimately needs `cli → @junction/mcp-server`. The correct model:
- **Apps (composition roots): `cli`, `web`.** May import any lib (`core`, `mcp/server`, `mcp/client`). **Nothing may import an app** (they're entry points / leaves).
- **Libs: `core`, `mcp/server`, `mcp/client`.** `core` imports nothing in-repo; `mcp/server`/`mcp/client` import **only `core` + the MCP SDK** — never each other, never an app.

Refine `.dependency-cruiser.cjs` to encode this, and update `docs/principles/modularity.md`. **VERIFY a matrix** (reproduce like the inc-3 fix): `cli → @junction/mcp-server` ALLOWED; `mcp-server → @junction/cli` BLOCKED; `mcp-server → @junction/mcp-client` BLOCKED; `web → @junction/cli` BLOCKED; `core → @junction/mcp-server` BLOCKED (core imports nothing); `cli → @junction/core` still ALLOWED; `@junction/core/testing` subpath still ALLOWED; deep-internal imports still BLOCKED. Do **not** re-open the inc-3 subpath hole.

### New deps

- `@junction/mcp-server`: `@modelcontextprotocol/sdk@^1.29` + `@junction/core` (`workspace:*`). Add `references: [{ path: "../../core" }]` to `packages/mcp/server/tsconfig.json` (note the depth — mcp/server is nested) + `types: ["node"]`. tsdown build + a build script.
- `cli`: add `@junction/mcp-server: "workspace:*"` (the new app→lib edge).

### Proof of done

- `pnpm verify` with tests:
  - **InMemoryTransport round-trip** (in mcp-server): `createLinkedPair()`, a `Client` connects to `createMcpServer(profile)`, `client.listTools()` → `{ tools: [] }` (empty, NOT method-not-found — this verifies the tools-capability gotcha is handled), no error, clean close. (This is the spec's exact proof, no process spawning. Prototyped working with the low-level `Server` approach.)
  - **CLI serve smoke** (child-process): spawn the built `junction mcp serve`, send a JSON-RPC `initialize` + `tools/list` over stdin, assert a valid MCP response with empty tools; assert **stdout carries only MCP frames** (no log noise). Then close.
- `pnpm depcruise` clean AND the boundary matrix verified (cli→mcp-server allowed; reverse/peer blocked).
- `pnpm build` ships mcp-server + the cli `mcp serve`; the built command speaks MCP.
- SPDX; narrow barrels; committed; CI green.

### Out of scope

- Any actual tools / connecting real sources (post-foundation — that's the whole point of the foundation being "ready" after inc 8). Streamable HTTP transport + the long-running daemon (`junction serve` the daemon). `mcp/client` (reserved). Credential access (no tools ⇒ none). Profile creation via CLI.

---

## Part 2 — Implementation

### Step 1 — boundary refinement first (so the new edge is governed when added)

Refine `.dependency-cruiser.cjs`: replace the symmetric `no-cross-edge-imports` with the app-vs-lib model (apps=cli/web may import libs; libs=core/mcp-server/mcp-client import only core; nothing imports an app; mcp-server↮mcp-client). Keep the inc-3 subpath allowance (`/src/index.ts` + `/src/testing/index.ts` only) and no-deep-internal-imports intact. Update `docs/principles/modularity.md` §3 to document app-vs-lib (cli/web are composition roots). **Verify the matrix** (Proof-of-done) before proceeding — a planted `mcp-server→cli` import must BLOCK, `cli→mcp-server` must pass.

### Step 2 — `@junction/mcp-server` package

`packages/mcp/server/package.json`: add deps (`@modelcontextprotocol/sdk@^1.29`, `@junction/core: workspace:*`), `"build": "tsdown"` script, keep private+AGPL. `tsconfig.json`: add `references: [{ path: "../../core" }]` + `types: ["node"]`. `tsdown.config.ts` (entry `src/index.ts`, esm, `.js` ext like core).

### Step 3 — `createMcpServer` + `serveStdio`

`packages/mcp/server/src/`:
- `server.ts` — `createMcpServer(profile: Profile): Server` (low-level `Server` per the verified gotcha above): `new Server({ name: "junction", version: "0.0.0" }, { capabilities: { tools: {} } })` + `setRequestHandler(ListToolsRequestSchema, async () => ({ tools: deriveToolsFromProfile(profile) }))`. `deriveToolsFromProfile` returns `[]` now. Code comment: future tools MUST be `<namespace>__<tool>` via `core.namespacedTool(sourceRef.toolNamespace, toolName)`; one server per Profile (per-profile isolation). Optionally surface the profile name in server info (no secrets).
- `serve.ts` — `serveStdio(profile: Profile): Promise<void>` → `const t = new StdioServerTransport(); await createMcpServer(profile).connect(t)`. Lazy-import the stdio transport if it keeps the lib import-light.
- `index.ts` — narrow barrel: export `createMcpServer`, `serveStdio`. Replace the `PLACEHOLDER`.

### Step 4 — cli `mcp serve`

`packages/cli/src/commands/mcp.ts` — citty `mcp` command, `serve` subcommand with `--profile <name>`. Load the profile: open the DB (`@junction/core` getDatabase + profilesRepo.getByName), or a synthetic `{ id, name: "default", sources: [], mcpEndpointPath: deriveMcpEndpointPath("default") }` if absent/omitted. Call `serveStdio(profile)`. **CRITICAL: no stdout output except MCP** — route any human note to stderr; do not `consola.log` to stdout in this command. Register `mcp` in `src/index.ts` root.

### Step 5 — tests

- mcp-server `*.test.ts`: InMemoryTransport `createLinkedPair()`; `Client` connect to `createMcpServer(defaultProfile)`; `await client.listTools()` → `{ tools: [] }`; clean close. (Two servers for two profiles are independent.)
- cli `mcp.test.ts`: child-process spawn the built `dist/index.js mcp serve`, write a JSON-RPC `initialize` then `tools/list` to stdin, read stdout frames, assert valid response + empty tools + **no non-JSON-RPC lines on stdout**. Use a tmp `JUNCTION_HOME`. (Keep it robust — MCP handshake over stdio; if flaky, assert at least the initialize handshake completes.)
- Update `junction-dev` skill with `junction mcp serve`.

### Step 6 — deps, verify, build, commit

- `pnpm add --filter @junction/mcp-server @modelcontextprotocol/sdk@^1.29 @junction/core@workspace:*`; `pnpm add --filter junction @junction/mcp-server@workspace:*`; `pnpm install`.
- `pnpm verify`; `pnpm build`; the built `junction mcp serve` MCP smoke; `pnpm depcruise` (clean + matrix).
- SPDX. Commit; push; PR (base main): "feat: mcp/server shell — McpServer per profile over stdio + junction mcp serve (increment 7)".

---

## Review (background, after build)

- **`junction-mcp-contract` (ACTIVATES — mandatory):** `<namespace>__<tool>` convention wired for future tools; **per-profile server isolation** (one McpServer per Profile, not a shared filtered endpoint); transport correctness (stdio; **no SSE**); zero tools now but the registration path is convention-correct; **no credential leakage** (no tool results, no secrets — trivially true at zero tools, but confirm no path touches the credential store); stdout-is-MCP-only in `serve`.
- **`junction-package-boundary` (the boundary refinement is the headline):** verify app-vs-lib is correct — cli→mcp-server allowed, mcp-server→cli/mcp-client blocked, core imports nothing, inc-3 subpath rule intact, no over-loosening.
- Junction: `junction-clean-code-reviewer` (edge-thin serve command, narrow barrels, no stdout noise).
- CE: `ce-architecture-strategist` (app-vs-lib model sound?), `ce-correctness-reviewer` (the MCP handshake, profile loading/default, server lifecycle/close), `ce-reliability-reviewer` (serve process lifecycle, transport close, no hang), `ce-testing-reviewer` (the InMemoryTransport + child-process MCP coverage).
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

Close with: **visually testable — YES:** `junction mcp serve` speaks MCP over stdio — provide a way to see it (a JSON-RPC `initialize`+`tools/list` piped in, or wiring it into an MCP client's config to watch "junction" connect with zero tools). **QA'd by me:** drove the built `mcp serve` with a real MCP handshake (empty tools, stdout MCP-only); the InMemoryTransport round-trip; the boundary matrix (cli→mcp-server allowed, reverse blocked). **Checklist:** McpServer-per-profile, zero tools, stdio (no SSE), `<namespace>__<tool>` wired for future tools, no credential path, stdout-is-MCP-only, app-vs-lib boundary refined + verified (no inc-3-style over-loosening).

## User test gate

`pnpm build`, then pipe an MCP handshake into the server:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | JUNCTION_HOME=/tmp/jt7 node packages/cli/dist/index.js mcp serve
```
You should see junction's MCP responses (an `initialize` result, then an empty `tools` array). Optionally wire it into Claude Desktop's MCP config to watch "junction" connect. Approve before increment 8 (sandbox — the last before "foundation ready").
