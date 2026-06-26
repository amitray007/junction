# Method File 14 — Source-provider abstraction + dispatch-by-kind (OpenAPI prep)

> **A pure refactor that sets up "any source".** Generalize the MCP-only proxy into a source-agnostic one: a `ToolProvider` interface in `core`, the **proxy + namespacing relocated to `core`**, MCP becomes one `ToolProvider` (in `mcp/client`), and the cli dispatches per source by `Platform.kind`. **No new user-visible surface, no behavior change** — MCP serving must be byte-identical. This is the clean base that increment 15 plugs OpenAPI into (and 17 GraphQL). Done on a proxy we *just* hardened (inc 12) through four reviews — so isolating this refactor and proving MCP unchanged is the whole point.
>
> **Builder:** Sonnet, with care to PRESERVE EXACT BEHAVIOR (namespacing, toolFilter on list+call, per-source skip, the ≤64 guard, connect-per-call + close). **No boundary-rule edit** — the design keeps it clean by construction.

---

## Part 1 — Spec (what & why)

### Goal

Decouple the profile proxy from MCP so future source types (OpenAPI, GraphQL) plug in without touching the proxy. Realizes the "any source" thesis at the architecture level. Proof: the existing MCP proxy tests pass unchanged (moved to core); `mcp serve` over an MCP source produces byte-identical output; `pnpm verify` + depcruise green; **zero new dependencies**.

### The abstraction (in `core`)

```ts
// core/src/sources/provider.ts
export interface ProviderTool { name: string; description?: string; inputSchema: object }   // RAW upstream name
export interface ToolResult { content: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean }
export interface ToolProvider {
  listTools(): ResultAsync<ProviderTool[], UpstreamError>                 // raw (un-namespaced) tools
  callTool(name: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError>  // raw name
  close(): Promise<void>
}
```
- **Providers return RAW tool names** and take RAW names in `callTool`. **Namespacing (`<ns>__<tool>`, the ≤64 guard), `toolFilter` (allow/deny on list AND call), and per-source routing/skip move INTO the proxy** — one enforcement point, every provider (MCP now, OpenAPI/GraphQL later) gets identical treatment for free (DRY; no drift). This is a refactor of WHERE the logic runs, not WHAT it does.
- `ToolResult` (currently a `mcp/client` type) moves to `core` (the interface references it).

### What moves to `core` (pure orchestration, no I/O, no transport)

- `createProfileProxy` + the naming helpers (`namespaceToolName`/`splitNamespacedName` + the ≤64 / illegal-char guard) move from `@junction/mcp-client/src/proxy.ts` + `helpers.ts` → `core/src/sources/` (`proxy.ts`, `naming.ts`). They are I/O-free orchestration (the principles doc: logic in core, edges thin).
- The proxy's new shape: `createProfileProxy(sources, resolveProvider)` where
  `resolveProvider(sourceRef): ResultAsync<{ provider: ToolProvider; toolNamespace: string; toolFilter? }, UpstreamError>`.
  Per enabled source: `resolveProvider` → `provider.listTools()` (raw) → **proxy namespaces + ≤64-guards + applies toolFilter** → aggregate (per-source skip on failure) → `provider.close()`. `callTool`: split first `__` → match namespace → toolFilter check → `provider.callTool(strippedName, args)` → `provider.close()`. **Connect-per-call + close, per-source skip, toolFilter on both paths, the ≤64 guard — all preserved exactly.**

### MCP becomes one provider (`@junction/mcp-client`)

- Add `McpToolProvider` (or a `createMcpProvider(connection, secret): ToolProvider`) wrapping the existing `connectSource`/`UpstreamSession`: `listTools` returns RAW upstream names (the namespacing it used to do moves to the core proxy — so the session/provider just lists/calls raw); `callTool(rawName, args)` calls the upstream raw name; `close` closes the session. `mcp/client` imports `core` (the `ToolProvider` interface) — unchanged boundary. The transport/connect logic (`connect.ts`, `session.ts`) stays; only the namespacing responsibility leaves.
- `mcp/client` no longer exports the proxy (it's in core now). It exports `createMcpProvider` + the connect/session pieces.

### cli dispatch by `Platform.kind` (the composition root)

- The cli's resolver becomes `resolveProvider(sourceRef)`: load the Platform; **switch on `platform.kind`** → `"mcp"` → build an `McpToolProvider` (from `mcp/client`, using `platform.connection` + the resolved secret); **`"openapi"`/`"graphql"`/`"cli"`/`"custom"` → a clean typed `unsupported-source-kind` error (skipped per-source) for now** (inc 15 wires `"openapi"`). The cli imports both `core` (proxy) + `mcp/client` (provider) — app→lib, allowed.
- `mcp serve` wiring: `createProfileProxy` now comes from `core`; everything else (resolve secret, build provider, adapt to `{listTools, callTool}` handlers, `createMcpServer`) unchanged. **stdout-MCP-only preserved.**

### Boundary (no rule edit — clean by construction)

- `core`: gains `sources/` (interface + proxy + naming). core still imports nothing in-repo, no HTTP, no transport — the proxy is pure orchestration over the interface. ✓
- `mcp/client → core` (provides `McpToolProvider`); `mcp/server → core` only (unchanged — still takes injected handlers); `cli → core + mcp/client`. **`mcp/server` still never imports `mcp/client`.** No sibling import. Confirm `tsconfig.depcruise.json` still maps everything to `src` (the "green but blind" gotcha) — no new package this increment.

### Proof of done

- `pnpm verify`: the MCP proxy tests (currently `mcp/client/src/proxy.test.ts`) **move to `core` and pass unchanged in assertions** (now exercising `core`'s proxy over a fake `ToolProvider` instead of an in-memory session). `mcp/client` keeps its connect/session/transport tests + a new `McpToolProvider` adapter test (lists RAW names, calls raw, closes). The namespacing/toolFilter/skip/≤64/credential-discipline tests all still pass — **behavior identical**, just relocated.
- **Behavior-identical proof:** a test that runs the SAME profile through the new core proxy + an `McpToolProvider` over an in-memory MCP server and asserts the SAME namespaced tool list + routed call result as before. The sentinel-credential test moves with it (secret never in any result/error).
- `pnpm build`; `pnpm depcruise` clean (no new edges; `mcp/server ⊥ mcp/client` still holds; proxy now in core); `pnpm quality` (jscpd 0 — watch for dup between the moved code and any leftover). SPDX; CI green.
- **MANUAL QA (orchestrator):** `mcp serve --profile <name>` over the everything-demo stdio source → byte-identical `tools/list` (`<ns>__<tool>`) + a routed `tools/call` result vs. pre-refactor; an `openapi`-kind platform (if one is added) → cleanly skipped with the unsupported-kind note (not a crash).

### Out of scope

- The OpenAPI provider / parser / HTTP executor / connection schema (increment 15). `platform add --kind openapi` (15). Any new dependency. Any behavior change to MCP serving. GraphQL (17+).

---

## Part 2 — Implementation

### Step 1 — core abstraction + relocate proxy/naming

`core/src/sources/`: `provider.ts` (`ToolProvider`, `ProviderTool`, `ToolResult`), `naming.ts` (`namespaceToolName` + ≤64/illegal guard, `splitNamespacedName` — moved verbatim from `mcp/client/helpers.ts`), `proxy.ts` (`createProfileProxy` — moved from `mcp/client`, retargeted to `ResolveProviderFn` returning a `ToolProvider`; namespacing/toolFilter/skip/≤64 logic now applied here over RAW provider tools). Export from a narrow `core` barrel (`core/src/index.ts`). Keep `UpstreamError` in `core/src/errors` (already there). NO new deps; NO HTTP/fs.*Sync in core.

### Step 2 — mcp/client: McpToolProvider adapter

`mcp/client`: add `createMcpProvider(connection, secret): ToolProvider` (or a class) wrapping `connectSource`/`UpstreamSession` so `listTools` returns RAW upstream tool names (remove the namespacing that now lives in core's proxy — confirm the session no longer prefixes), `callTool(rawName, args)` calls the raw upstream name, `close()` closes. Remove the proxy + naming from `mcp/client` (now in core); update the barrel. Keep connect/session/transport + their tests.

### Step 3 — cli dispatch

`commands/mcp.ts`: change the resolver to `resolveProvider(sourceRef)` switching on `platform.kind` → `"mcp"` builds the `McpToolProvider` (resolve secret as today, pass `connection`+secret); other kinds → typed `unsupported-source-kind` (skipped). Import `createProfileProxy` from `core` (not `mcp/client`). Adapt the proxy to the `createMcpServer` handler shape as before. stdout-MCP-only intact.

### Step 4 — tests move + behavior-identical guard

Move `proxy.test.ts` (+ the sentinel-credential + toolFilter + multi-source + per-source-skip + ≤64 + routing tests) to `core`, re-pointed at a fake `ToolProvider` (no transport needed → simpler + faster). Add the `McpToolProvider` adapter test in `mcp/client`. Add the behavior-identical end-to-end (in-memory MCP server → McpToolProvider → core proxy → same namespaced output). Confirm `pnpm dup` 0 (no leftover duplicate of the moved code).

### Step 5 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` (clean) + `pnpm build`. SPDX. Commit; push; PR base main: "refactor: source-provider abstraction + dispatch-by-kind (OpenAPI prep / increment 14)".

---

## Review (background, after build)

- **`junction-mcp-contract`**: the relocated proxy preserves namespacing/routing/toolFilter (list AND call)/per-source-skip/≤64 exactly; `McpToolProvider` lists RAW + the proxy namespaces (no double-prefix, no drop); credential still never in any result/error; stdout-MCP-only.
- **`junction-package-boundary`**: proxy in core (pure, no I/O); `mcp/server ⊥ mcp/client` still; `cli → core + mcp/client`; no `.dependency-cruiser.cjs` change; tsconfig.depcruise maps intact.
- **`ce-correctness-reviewer`** (the relocation didn't change behavior — namespacing/skip/close lifecycle/toolFilter edge cases), **`ce-reliability-reviewer`** (provider close on every path, per-call lifecycle preserved — the inc-11/12 leak class must not regress), **`ce-testing-reviewer`** (the behavior-identical guard + moved coverage).
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — NO** (pure refactor; no new user surface). It *becomes* visible in increment 15 (OpenAPI source you can call). **QA'd by me:** drove `mcp serve` over the everything-demo source and confirmed byte-identical `tools/list` + a routed `tools/call` vs. pre-refactor; the moved proxy tests + behavior-identical guard pass; depcruise clean (proxy in core, `mcp/server ⊥ mcp/client` intact); reviews addressed. **Checklist:** `ToolProvider` interface in core, proxy+namespacing relocated to core, MCP as a provider (raw names; proxy namespaces), cli dispatch by `platform.kind`, behavior byte-identical (namespacing/toolFilter/skip/≤64/credential-discipline preserved), no new deps, no boundary-rule edit, `mcp/server ⊥ mcp/client` holds.

## User test gate

This is a no-op for you behaviorally — `mcp serve` works exactly as before. To confirm nothing regressed:
```bash
JUNCTION_HOME=/tmp/jtest node packages/cli/dist/index.js debug mcp-probe --platform everything --credential <id>   # same namespaced tools as before
# (or the inspector against `mcp serve --profile test` — identical to inc-12 behavior)
```
Approve → increment 15 (the OpenAPI provider — point junction at a REST/OpenAPI spec and call its endpoints as tools; the "any source" payoff).
