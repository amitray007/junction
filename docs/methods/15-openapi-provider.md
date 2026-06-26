# Method File 15 — OpenAPI/REST source provider (the "any source" payoff)

> **junction becomes more than an MCP proxy.** Point it at any **OpenAPI/REST spec** (no MCP server needed) and an agent calls the API's endpoints as namespaced tools through a profile — credential injected per the spec's security scheme, response returned. Built on inc-14's `ToolProvider` abstraction: a new `@junction/openapi-client` is just another provider; the proxy/profile/credential/namespacing machinery is reused unchanged. This is the explicit Composio gap (idea.md §competitive) and goal #1's "many source kinds."
>
> **Builder:** Sonnet, with care (a new outbound-HTTP + credential-at-request path + spec parsing of untrusted input). **End-to-end tested against a REAL local OpenAPI server** (the user's directive), not just unit tests.

---

## Part 1 — Spec (what & why)

### Goal

Implement `kind:"openapi"` end-to-end: define an OpenAPI platform, and its operations surface as `<ns>__<operationId>` tools that an agent can call (real HTTP request, credential injected, response returned). Proof: against a real OpenAPI server (local + a public one), `mcp serve`/the provider lists the spec's operations as tools and a call performs the real HTTP request and returns the body — the credential injected into the request, never in the result/log.

### Locked decisions (from research)

- **Parser:** `@scalar/openapi-parser` — `dereference()`→`{schema, errors}` (Result-friendly, no throw), `validate()`, `upgradeFromTwoToThree` (Swagger 2.0→3.0). junction **fetches the spec URL itself** (own `fetch`, SSRF-controlled), then `dereference` (don't auto-fetch remote `$ref`s — restrict to the spec doc; `$ref` remote-fetch allowed at add-time only, not serve).
- **HTTP:** Node 22 global `fetch`/undici — **no new HTTP dep**. `AbortController` for the 30s timeout; `redirect:"manual"`; streamed response **byte-cap = 1 MB** (abort past it → `response-too-large`).
- **maxTools cap = 75.** A spec with more operations and no selection → **refuse** at add-time with a tag listing (selection UX is inc 16). Small specs (≤75) just work.
- **Arg validation v1 = minimal** (required path params present + body JSON-serializable → `invalid-args`); full ajv JSON-Schema validation deferred (Zod-first; ajv would be the first JSON-Schema-validator dep).
- **basic-auth:** username in the descriptor, secret = password. **No outbound sandbox v1** (operator-configured host); record the egress-sandbox trigger in `docs/futures`.

### New package `@junction/openapi-client` (a `ToolProvider`)

- `createOpenApiProvider(connection: OpenApiConnection, secret: string|null): ToolProvider` (implements inc-14's interface).
  - **listTools():** parse the (cached) spec → one `ProviderTool` per operation: `name` = sanitized `operationId` (to `^[a-zA-Z0-9_-]{1,64}$`; missing/collision → `method_path` derived + dedupe); `description` = summary ?? description; `inputSchema` = JSON Schema merging path+query+header+cookie params (under their names) + requestBody JSON (nested under `body`). Normalize OpenAPI 3.0 schemas (`nullable`→`type:[…,"null"]`) before emitting. **Returns RAW operationId names** (the core proxy namespaces). `too-many-tools` if over cap (when reached at serve from a cached big spec — shouldn't happen if add-time refused, but guard).
  - **callTool(operationId, args):** find the operation; build the request — substitute path params (`encodeURIComponent`; REJECT a path value with `/`, `..`, control chars, or a host/scheme → `invalid-args`); query via `URLSearchParams`; headers; JSON body from `args.body`; base URL = `connection.baseUrl` ?? spec `servers[0]` (scheme ∈ {http,https}, **host pinned** — agent args never set scheme/host/path-template). **Inject the credential** per `connection.auth` into the request ONLY (header/query/cookie/bearer/basic). `fetch` (timeout, manual-redirect, byte-cap) → `ToolResult{ content:[{type:"text", text: status + body}], isError: status>=400 }`. Errors → typed `UpstreamError`.
  - `close()`: no-op (stateless HTTP).
- Deps: `@scalar/openapi-parser` + `@junction/core` (the `ToolProvider` interface + types). Lib boundary: `openapi-client → core` only.

### `OpenApiConnectionSchema` (in `core`, data only — no parser dep)

```ts
const SpecSource = z.discriminatedUnion("from", [
  z.object({ from: z.literal("url"), url: z.string().url() }),
  z.object({ from: z.literal("file"), path: z.string().min(1) }),
  z.object({ from: z.literal("inline"), document: z.unknown() }),
])
const OpenApiAuth = z.discriminatedUnion("scheme", [
  z.object({ scheme: z.literal("apiKey"), in: z.enum(["header","query","cookie"]), name: z.string().min(1) }),
  z.object({ scheme: z.literal("bearer"), header: z.string().min(1).default("Authorization") }),
  z.object({ scheme: z.literal("basic"), username: z.string().min(1) }),   // secret = password
  z.object({ scheme: z.literal("oauth2") }),                                // token as bearer
])
export const OpenApiConnectionSchema = z.object({
  spec: SpecSource,
  baseUrl: z.string().url().optional(),
  auth: OpenApiAuth.optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  maxTools: z.number().int().positive().optional(),
})
```
- `Platform` gains `openapi: OpenApiConnectionSchema.optional()` (additive; parallel to the MCP `connection`). DB: additive nullable `openapi` text column → **migration 0003** (drizzle-kit generated, snapshot included — the prior gotcha). Repos serialize/validate it (Zod on read).
- **Spec cache:** at `platform add`, fetch+parse+validate, derive `auth` from the spec's `securitySchemes` (or flags), and cache the dereferenced doc at `~/.junction/openapi/<platformId>.json` (`getPaths()`). At serve, load from cache (fast, offline). (`platform refresh` to re-fetch is inc 16.)

### `UpstreamError` additions (core)

`| {kind:"spec-parse-failed"; cause} | {kind:"spec-fetch-failed"; cause} | {kind:"invalid-args"; reason} | {kind:"response-too-large"; limit} | {kind:"too-many-tools"; count; cap}`. `safeUpstreamMessage` (mcp/server) extends exhaustively (no secret/cause).

### CLI

- `platform add --kind openapi --spec-url <url> [--base-url <url>] [--auth-scheme apiKey|bearer|basic] [--auth-in header|query|cookie] [--auth-name <name>] [--auth-username <u>]` — fetch+parse+validate the spec; derive `auth` from `securitySchemes` if not flagged; **refuse if operation count > maxTools** with a message listing the spec's tags + counts ("narrow with selection (coming in a later release) or pick a smaller spec"); cache the spec; create the Platform with the `openapi` descriptor. `--json`.
- cli `resolveProvider` (inc 14): add `kind:"openapi"` → `createOpenApiProvider(platform.openapi, secret)` (load cached spec + resolved secret). The secret resolves exactly like MCP (CredentialStore.get); injected into the HTTP request only.
- `credential add`/`profile add-source` reused unchanged (a bearer/api-key credential + a SourceRef with a toolNamespace).

### Security (reuse the discipline + HTTP-specific)

- **Credential into the request only** — header/query/cookie/bearer/basic — NEVER in the tool result, log, error, or the request **URL surfaced anywhere** (apiKey-in-query puts the secret in the URL → never log/return the URL; scrub it). Extend the `String(cause)` rule.
- **SSRF/host-pin:** base URL host is operator-configured; validate scheme ∈ {http,https}; agent args fill path/query/body VALUES only, never scheme/host/path-template; `redirect:"manual"`. `$ref` remote-fetch only at add-time.
- **Path injection:** `encodeURIComponent` path values; reject `/`/`..`/control/host-like.
- **Response limits:** 1 MB byte-cap + 30s timeout (no OOM).
- **No outbound sandbox v1** (futures trigger recorded).

### Proof of done

- `pnpm verify` with tests (a LOCAL in-test HTTP server — `node:http` — serving a small hand-written spec + endpoints, so no network in CI):
  - parse→tools: a 3-operation spec → 3 `ProviderTool`s with correct names (operationId; a missing-operationId op → `method_path`), descriptions, merged inputSchema (path+query+body); 3.0 `nullable` normalized.
  - HTTP executor: `callTool` performs a real request to the local server; path/query/body assembled correctly; response mapped (200 → result, 4xx → isError); a too-large response → `response-too-large`; a timeout → `timed-out`.
  - **credential injection per scheme:** the local server asserts it RECEIVED the apiKey header / bearer / basic (echoing only *whether*, never the value); a sentinel secret → appears in NO tool result/error/log/URL-in-output.
  - path-injection: a path arg with `../` or `/` → `invalid-args` (no request sent).
  - maxTools: a >cap spec at add → refusal with tag listing.
  - migration 0003 applies on 0000-0002; the `openapi` descriptor round-trips through the repo (Zod-validated).
- `pnpm build`; `pnpm depcruise` clean (`openapi-client → core` only; `mcp/server ⊥ both`; cli → all libs); `pnpm quality`. SPDX; CI green.
- **MANUAL QA (orchestrator — END-TO-END against a REAL OpenAPI server, per the user's directive):**
  1. **Local:** build a tiny `node:http` OpenAPI server (a hand-written spec + 2-3 endpoints; one requires an `X-API-Key` header and 401s without it — to PROVE credential injection). `platform add --kind openapi --spec-url http://localhost:PORT/openapi.json` + `credential add` (the key) + `profile add-source` → drive the provider (`debug mcp-probe` or a direct provider call): list the operations as tools, **call one with the key injected (200) and confirm the same call without the source's credential would 401** — proving the credential reaches the request. Confirm the key appears in NO output.
  2. **Public (if reachable):** point at a real public spec (e.g. Swagger Petstore `https://petstore3.swagger.io/api/v3/openapi.json` or httpbin) → list operations → call a no-auth GET → real response. (If offline/unreachable, the local server is the authoritative end-to-end.)

### Out of scope

- Rich spec **selection UX** (`--tag/--path/--operation`) + `platform refresh` (increment 16). GraphQL (17+). Full ajv arg validation. OAuth token *acquisition* (the `oauth2` scheme here just injects a pre-obtained token as bearer; the OAuth dance is the later OAuth increment). Web UI.

---

## Part 2 — Implementation

### Step 1 — core: schema + errors + Platform field + migration

`core/src/schema/openapi-connection.ts` (the Zod schema above); add `openapi` to `PlatformSchema`; add `openapi` text column to `platforms` in `db/schema.ts` → **migration 0003** via drizzle-kit (snapshot included; confirm dist packaging). `UpstreamError` additions in `errors/index.ts`. Repo `platforms` serialize/Zod-validate the `openapi` JSON (mirror the `connection` handling). Barrel exports.

### Step 2 — `@junction/openapi-client` package

`packages/openapi/client/` (or `packages/openapi-client/` — match the repo's package layout; mcp/* uses `packages/mcp/{server,client}` so consider `packages/openapi/client`). package.json (deps `@scalar/openapi-parser` + `@junction/core` workspace; build script; private+AGPL), tsconfig (reference core), tsdown config. Modules: `parse.ts` (fetch URL / read file / inline → validate → dereference → return the doc or typed `spec-*` error), `tools.ts` (operations → `ProviderTool[]`: operationId sanitize+dedupe, inputSchema merge, 3.0 normalize), `http.ts` (build request + inject credential per auth + fetch with timeout/byte-cap/manual-redirect → `ToolResult`/typed error), `provider.ts` (`createOpenApiProvider` → `ToolProvider`). Narrow barrel. Add the package to `tsconfig.depcruise.json` paths (the "green but blind" gotcha) + root pnpm catalog if used.

### Step 3 — cli

`commands/platform.ts`: extend `add` for `--kind openapi` (fetch+parse+validate via openapi-client's parse, derive auth, refuse over cap with tag listing, cache the dereferenced spec to `~/.junction/openapi/<id>.json`, create the Platform with `openapi`). `commands/mcp.ts` `resolveProvider`: `kind:"openapi"` → load cached spec + `createOpenApiProvider(platform.openapi, secret)`. Lazy-import openapi-client. `--json`; typed errors; stdout-MCP-only in serve.

### Step 4 — tests (local http server) + docs

Per Proof-of-done. The credential-injection + path-injection + byte-cap + sentinel tests run against an in-test `node:http` server (no network). Record futures: `gotchas.md` (OpenAPI 3.0→JSON-Schema nullable normalization; apiKey-in-query URL-secret scrub; scalar `$ref` opt-in fetch), `revisit-when.md` (egress sandbox for untrusted OpenAPI hosts; rich selection UX = inc 16; ajv full validation). Update `junction-dev` skill with `platform add --kind openapi`.

### Step 5 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` (clean; new package governed) + `pnpm build`. SPDX. Commit; push; PR base main: "feat: OpenAPI/REST source provider — call any REST API as namespaced tools (increment 15)".

---

## Review (background, after build)

- **`junction-credential-security`**: the credential injected into the HTTP request ONLY (header/query/cookie/bearer/basic), never in result/error/log/URL-in-output (esp. the apiKey-in-query URL-leak); secret resolved per-call, not retained.
- **`junction-mcp-contract`**: OpenAPI tools surface namespaced `<ns>__<op>` via the core proxy; callTool routes + executes the right operation; per-source skip; toolFilter applies (it's in the proxy now — provider returns raw names).
- **`ce-security-reviewer`**: SSRF/host-pin, path/query injection from agent args, `$ref` fetch surface, response/timeout limits, untrusted-spec parsing (a malicious spec can't make junction request an internal host or leak the credential).
- **`ce-data-migration-reviewer`** (migration 0003 additive + snapshot), `junction-package-boundary` (openapi-client→core only; mcp/server ⊥ both), `ce-correctness-reviewer` (operationId dedupe, inputSchema merge, request building, error mapping), `ce-reliability-reviewer` (timeout/byte-cap/no-leak), `junction-clean-code-reviewer`.
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** `platform add --kind openapi --spec-url …` + credential + profile, then list + call the REST operations as tools (against a real/local spec). **QA'd by me:** stood up a real local OpenAPI server (one endpoint requiring an API key), connected it, listed its operations as namespaced tools, **called one with the credential injected (200) — proving the key reaches the request and a keyless call 401s** — and confirmed the key appears in no output/URL; (+ a public spec if reachable); migration 0003 applies; reviews addressed. **Checklist:** spec parse→tools (operationId/inputSchema/3.0-normalize), HTTP executor (path/query/body, host-pin, byte-cap, timeout), credential injection per scheme (request-only), maxTools refusal, additive migration 0003, source-agnostic, openapi-client→core boundary, no-secret-anywhere.

## User test gate

`pnpm build`, then (a public REST API with an OpenAPI spec, or your own):
```bash
JUNCTION_HOME=/tmp/jt15 node packages/cli/dist/index.js init
JUNCTION_HOME=/tmp/jt15 node packages/cli/dist/index.js platform add --id petstore --kind openapi \
  --display-name "Petstore" --spec-url https://petstore3.swagger.io/api/v3/openapi.json
echo "<api-key-if-needed>" | JUNCTION_HOME=/tmp/jt15 node packages/cli/dist/index.js credential add --platform petstore --account me --kind bearer --token-stdin
JUNCTION_HOME=/tmp/jt15 node packages/cli/dist/index.js profile create --name api
# add-source --profile api --platform petstore --credential <id> --namespace petstore
JUNCTION_HOME=/tmp/jt15 node packages/cli/dist/index.js debug mcp-probe --platform petstore --credential <id>   # lists petstore__<op> tools
# then mcp serve --profile api / the MCP inspector → call petstore__getPetById
```
Approve → increment 16 (large-spec selection `--tag/--path` + `platform refresh`) — then GraphQL, then the Web UI / OAuth.
