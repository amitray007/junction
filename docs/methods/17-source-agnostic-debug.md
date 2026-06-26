# Method File 17 — Source-agnostic debug surface (probe + call, any source kind)

> **`debug` should work for every source, not just MCP.** Today `debug mcp-probe` is built on the MCP-specific `connectSource` and bails for OpenAPI platforms (`debug.ts:141`); it only *lists* tools, and it re-implements the namespacing the core proxy already does (`debug.ts:199-211`). This increment rebuilds debug on junction's **source-agnostic `ToolProvider` abstraction** (inc 14) so probing works for MCP **and** OpenAPI (GraphQL later, for free), and adds **`debug call`** — actually invoke a tool against any source from the CLI, which today is impossible without `mcp serve` + an agent (I had to hand-script it in the inc-16 e2e).
>
> **Builder:** Sonnet. The one careful part is extracting provider-building out of `mcp.ts` **without changing `mcp serve` behavior**.

---

## Part 1 — Spec (what & why)

### Goal

A source-agnostic `debug` surface, built on `ToolProvider`:
- **`debug probe --platform <id> [--credential <id>]`** — dispatch by `platform.kind`, list the source's tools (raw + namespaced) for **MCP and OpenAPI** (and any future kind). Replaces the MCP-only path; `mcp-probe` stays as a deprecated alias.
- **`debug call --platform <id> [--credential <id>] --tool <rawName> --args <json>`** — build the provider, invoke one tool, print the result. This is the missing capability: a faithful end-to-end test harness that exercises the **same** provider/auth path `mcp serve` uses, without serving.

Proof: against a live local no-auth OpenAPI server, `debug probe` lists `getGreeting` and `debug call --tool getGreeting --args '{}'` returns the real 200 body — **with no credential** — and a credentialed MCP source still probes/calls as before.

### What exists vs the gap

- `ToolProvider` (core, inc 14): `listTools(): ResultAsync<ProviderTool[], UpstreamError>`, `callTool(rawName, args: Record<string,unknown>): ResultAsync<ToolResult, UpstreamError>`, `close(): Promise<void>`. Providers return **RAW** names; the proxy namespaces.
- `resolveProvider` (inside `cli/commands/mcp.ts`) already dispatches by `platform.kind` to `createMcpProvider`/`createOpenApiProvider` — but it's a **closure trapped in the serve command**, wrapping SourceRef→credential→secret→namespacing→toolFilter.
- **Asymmetry to normalize:** `createMcpProvider(conn, secret)` returns `ResultAsync<ToolProvider>` (eager connect); `createOpenApiProvider(conn, secret)` returns `ToolProvider` synchronously.
- **The gap:** `debug` can't reuse any of this — it's on the MCP-only `connectSource`. No CLI tool-invocation exists at all.

### The change

1. **Extract a shared CLI primitive `buildProvider`** (new `packages/cli/src/providers.ts`):
   `buildProvider(platform, secret, paths): ResultAsync<ToolProvider, UpstreamError>` — pure dispatch-by-kind, lazy-importing mcp-client/openapi-client (composition-root concern — this is the *app* wiring libs):
   - `kind === "mcp"`: guard `platform.connection` → `createMcpProvider(connection, secret)` (already `ResultAsync`).
   - `kind === "openapi"`: guard `platform.openapi` → async-read the cached spec at `join(paths.home, "openapi", `${platform.id}.json`)` → build the inline connection (`{...platform.openapi, spec:{from:"inline", document}}`) → `okAsync(createOpenApiProvider(conn, secret))`; cache-miss → `errAsync({kind:"connect-failed", cause})`.
   - else → `errAsync({kind:"unsupported-source-kind", platformKind})`.
   - **buildProvider does NOT write stderr** — it returns the error; callers report. (Serve writes its per-source "skipping" note; debug uses `reportUpstreamError`.)
2. **Extract `resolveCredentialSecret`** (same `providers.ts`): `(repos, paths, credentialId): ResultAsync<{secret: string|null, account: string}, …>` — the credential→store→secret resolution. Used by `debug probe` + `debug call` (rule-of-three: two debug sites + the conceptual serve site → extract). Absent/empty credentialId → `{secret:null, account:"public"}`, no store touch.
3. **Refactor `mcp.ts resolveProvider`** to call `buildProvider` for the kind-dispatch+build, keeping everything else identical (SourceRef→platform resolve, credential/secret resolve, the auth-declared-but-no-credential warning, namespacing via the proxy, toolFilter, the per-source stderr "skipping" notes on a `buildProvider` error). **`mcp serve` must stay byte-identical.**
4. **`debug probe`** (generic): platform + optional credential → `resolveCredentialSecret` → `buildProvider` → `listTools()` → derive namespace + apply `namespaceToolName` (≤64 guard) → print **both** raw and namespaced names (+ skipped count). `close()` in a `finally`.
5. **`debug call`**: platform + optional credential + `--tool <rawName>` + `--args <json>` → `buildProvider` → `callTool(rawName, parsedArgs)` → print `ToolResult.content` + `isError`. `close()` in `finally`. `--args` defaults to `{}`; parse+validate as a JSON **object** (bad JSON / non-object → clean `invalid tool arguments` error, not a throw).
6. **`mcp-probe` → deprecated alias** of `debug probe` (same handler; stderr note "mcp-probe is deprecated; use `debug probe`"). Keeps any existing scripts working; debug is non-production so churn is safe.

### Security / robustness invariants

- **Secret never printed.** It flows only into `buildProvider` → transport/`injectAuth`. `debug call` prints upstream `content` (data) + `isError` — the same bytes `mcp serve` would forward. The OpenAPI provider already returns leak-safe `"status\nbody"` (no URL, inc 15); MCP returns upstream content. No secret, no request URL, ever.
- **Always `close()` in `finally`** on both probe and call — a leaked connection/timer is the inc-11 hang gotcha. A failed `callTool` still closes.
- **`mcp serve` unchanged** — the extraction is behavior-preserving; the proxy path is untouched.
- **No new package edges** — `buildProvider` lives in `cli` (app), lazy-imports the lib providers. depcruise stays clean (cli → core + mcp/* + openapi-client; libs unchanged).
- **Source-agnostic** — adding GraphQL later means one new `buildProvider` branch; probe/call get it for free.

### Proof of done

- `pnpm verify` with tests:
  - `buildProvider`: MCP platform → provider; OpenAPI platform (cached spec) → provider; OpenAPI with missing cache → `connect-failed`; unknown kind → `unsupported-source-kind`; MCP/OpenAPI asymmetry normalized to `ResultAsync<ToolProvider>`.
  - `resolveCredentialSecret`: no credential → `{secret:null, account:"public"}` (no store touch); present credential → secret + profileName; not-found / store-fail → mapped error.
  - `debug probe`: lists tools for an OpenAPI **and** an MCP source (in-memory MCP server); raw + namespaced both present; no-credential path works; closes the provider.
  - `debug call`: invokes a tool against a local OpenAPI source → real result; no-credential path; **assert no secret and no request URL in the output**; bad `--args` → clean error; provider closed even on call failure.
  - `mcp-probe` alias still lists tools (+ emits the deprecation note).
  - `mcp serve` regression: the existing serve/proxy tests still pass unchanged (byte-identical behavior after the `buildProvider` extraction).
- `pnpm build`; `pnpm depcruise` (0 errors); `pnpm quality` (0 clones — extracting the shared helpers should *reduce* duplication, not add). SPDX on new files.
- **MANUAL QA (orchestrator) — via the CLI, no node script:** stand up the inc-16 local no-auth OpenAPI server; `platform add` it; `debug probe --platform pub` (no credential) → lists `getGreeting`; `debug call --platform pub --tool getGreeting --args '{}'` → real 200 body, no credential, no secret/URL in output. Repeat against a credentialed MCP source (everything-demo or a keyed source) → probe + call still work.

### Out of scope

- Profile-aware debug (debug operates on a platform+credential in isolation, not a profile's namespaced SourceRef). Large-spec `--tag/--path` selection + `platform refresh` (now increment 18). GraphQL provider (later). Any production/non-debug surface.

---

## Part 2 — Implementation

### Step 1 — shared primitives (`packages/cli/src/providers.ts`, new)

`buildProvider(platform, secret, paths): ResultAsync<ToolProvider, UpstreamError>` and `resolveCredentialSecret(repos, paths, credentialId?): ResultAsync<{secret: string|null, account: string}, …>` per the spec. Lazy-import `@junction/mcp-client` / `@junction/openapi-client` inside the OpenAPI/MCP branches (mirror the lazy imports in `mcp.ts`). Normalize the OpenAPI sync return via `okAsync(...)`. No stderr writes here.

### Step 2 — refactor `mcp.ts` resolveProvider

Replace the inline kind-dispatch+build (the MCP/OpenAPI branches at `mcp.ts:227-291`) with a call to `buildProvider(platform, secret, paths)`, mapping its `Ok` to `{provider, toolNamespace, toolFilter}` and writing the existing per-source "skipping" stderr note on its `Err`. Keep the credential/secret resolution + auth-declared warning + the SourceRef plumbing exactly as-is. Verify `mcp serve` is unchanged (run its tests).

### Step 3 — generalize debug (`packages/cli/src/commands/debug.ts`)

- Add `probeCommand` (`debug probe`): args `platform` (required), `credential` (optional), `json`. Resolve secret via `resolveCredentialSecret`; `buildProvider`; `listTools`; derive namespace (reuse `deriveProbeNamespace`); namespace each tool (`namespaceToolName`, count skipped); print raw + namespaced (+ skipped). `close()` in `finally`. Reuse `formatUpstreamError`/`reportUpstreamError` (already exhaustive).
- Add `callCommand` (`debug call`): args `platform` (required), `credential` (optional), `tool` (required, raw name), `args` (string JSON, default `"{}"`), `json`. Parse `args` → object (reject non-object/invalid → `invalid-args`-style error). `buildProvider`; `callTool(tool, parsed)`; print `content` + `isError`. `close()` in `finally`. NEVER print the secret.
- Keep `mcpProbeCommand` as a thin deprecated alias → delegate to the probe handler; stderr note. Register `probe`, `call`, `mcp-probe` under `debugCommand.subCommands`.

### Step 4 — tests + skill

Per Proof-of-done. Update `junction-dev` skill: `debug probe` / `debug call` for any source (MCP + OpenAPI), with the no-credential examples; note `mcp-probe` is deprecated.

### Step 5 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` + `pnpm build`. SPDX on `providers.ts`. Commit; push; PR base main: "feat: source-agnostic debug surface — probe + call any source (increment 17)".

---

## Review (background, after build)

- **`junction-clean-code-reviewer` + `junction-package-boundary`** (lead — this is a refactor/extraction): `buildProvider` + `resolveCredentialSecret` are correctly placed in `cli` (app wiring libs), no new core→lib or mcp/server→mcp/client edges, the extraction genuinely de-duplicates (proxy/mcp-probe namespacing + the secret-resolution), thin edges preserved, SPDX present.
- **`ce-correctness-reviewer`**: the MCP/OpenAPI `ResultAsync` asymmetry is normalized correctly; **`mcp serve` is behavior-identical** after the extraction (per-source skipping notes, auth warning, namespacing, toolFilter all intact); `--args` JSON parsing rejects non-objects cleanly; `close()` runs in `finally` on every path including call-failure.
- **`junction-mcp-contract`**: probe lists raw+namespaced correctly for both kinds; `call` dispatches the raw name; the ≤64 guard + skip behavior matches the proxy.
- **`junction-credential-security`**: secret never reaches probe/call output; `debug call` result content carries no secret/URL (OpenAPI `"status\nbody"`, MCP upstream content); no-credential path touches no store.
- Then `/ce-simplify-code` on the diff.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** `debug probe --platform <openapi-id>` lists tools and `debug call --platform <openapi-id> --tool <op> --args '{}'` returns a real response — for a public source with no credential, and for a credentialed MCP source. **QA'd by me:** drove `debug probe` + `debug call` via the built CLI against the live local no-auth OpenAPI server (no node script this time) and a credentialed source; confirmed no secret/URL in output, provider closed on every path, and `mcp serve` unchanged. **Checklist:** `buildProvider` source-agnostic dispatch (MCP+OpenAPI, asymmetry normalized), `resolveCredentialSecret` shared, `debug probe` any-kind (raw+namespaced), `debug call` any-kind (the new capability), `mcp-probe` deprecated alias, secret/URL never printed, `close()` in finally everywhere, `mcp serve` byte-identical, no new package edges, dedup not duplication.

## User test gate

```bash
pnpm build
# reuse the inc-16 local no-auth OpenAPI server (or any public spec)
JUNCTION_HOME=/tmp/jt17 node packages/cli/dist/index.js init
JUNCTION_HOME=/tmp/jt17 node packages/cli/dist/index.js platform add --id pub --kind openapi --display-name "Public API" --spec-url <no-auth-spec-url>
JUNCTION_HOME=/tmp/jt17 node packages/cli/dist/index.js debug probe --platform pub                          # lists tools, NO credential
JUNCTION_HOME=/tmp/jt17 node packages/cli/dist/index.js debug call --platform pub --tool <op> --args '{}'    # real response, NO credential
```
Approve → increment 18 (large-spec `--tag/--path` selection + `platform refresh`), then GraphQL, Web UI, OAuth.
