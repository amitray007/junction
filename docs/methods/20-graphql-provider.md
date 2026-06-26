# Method File 20 — GraphQL source provider (`graphql_query` / `graphql_mutation` / `graphql_schema`)

> **Broker any GraphQL API as namespaced tools, source-agnostic.** junction already serves MCP and OpenAPI/REST sources through one `ToolProvider` interface. This adds GraphQL: a new `@junction/graphql-client` lib exposing a **fixed set of three generic tools** — the agent writes GraphQL against an introspected schema (the model Shopify's and Apollo's MCP servers ship). GraphQL is *simpler* to broker than REST: a single pinned endpoint, no path-template substitution, no host-injection surface.
>
> **The one genuinely new design decision:** expose `graphql_query` and `graphql_mutation` as **separate** tools and **enforce the split** by parsing the document with graphql-js (`parse` → operation type). This makes a **read-only profile a real guarantee** — the proxy `toolFilter` omits `graphql_mutation`, AND the provider rejects a `mutation` sent through `graphql_query` (and rejects `subscription`, which has no transport here). Operation type lives in the *document*, never the transport — without parsing, the read-only promise would be cosmetic.
>
> **Builder:** Sonnet. Largest part is scaffolding a new lib package (mirror `openapi-client`) + a migration.

---

## Part 1 — Spec (what & why)

### Goal

`platform add --kind graphql --endpoint <url> [auth]` registers a GraphQL source; serving/probing a profile that references it exposes `<ns>__graphql_query`, `<ns>__graphql_mutation`, `<ns>__graphql_schema`. The agent calls `graphql_schema` to discover the SDL, then `graphql_query`/`graphql_mutation` to execute. Credentials are injected per-call (same model as OpenAPI). Proof: against a real GraphQL API (e.g. a public one, or GitHub GraphQL with a token), `graphql_schema` returns SDL and `graphql_query` returns real data — end-to-end through the built CLI.

### Design (validated by research; prior art: Shopify + Apollo MCP servers)

- **Generic-tool model, not per-field.** A fixed 3 tools regardless of schema size — avoids the tool explosion (GitHub/Shopify schemas have hundreds of root fields → would blow the 75-tool cap) and the hard GraphQL→JSON-Schema translation. Per-field "typed tools" (via a curated operation allowlist, à la Apollo) is **deferred**.
- **Three tools** (raw names; the proxy namespaces + `toolFilter`s):
  - `graphql_query` — `{ query: string (required), variables?: object, operationName?: string }`. Rejects a non-query document.
  - `graphql_mutation` — identical inputSchema; **omitted from read-only profiles**; rejects a non-mutation document.
  - `graphql_schema` — `{}` (no args) → returns the schema **SDL** for discovery.
- **Operation-type enforcement (the load-bearing novelty):** `callTool` runs `parse(query)` (graphql-js), selects the operation (by `operationName`, else the single/first definition), reads `.operation`; if it ≠ the tool's type → `invalid-args`; `subscription` → `invalid-args` (no transport). Syntax errors → `invalid-args` (saves a round-trip).
- **Schema as SDL, cached at add-time:** at `platform add`, POST `getIntrospectionQuery()` → `buildClientSchema(data)` → `printSchema()` → SDL, stored in the descriptor (`schemaSdl`). `graphql_schema` serves the cached SDL (fast, token-efficient, survives later introspection lockdown); if absent, attempts live introspection; on failure returns a clear message **without crashing the source** (`graphql_query`/`graphql_mutation` keep working).

### Wire mechanics (GraphQL-over-HTTP)

- `POST` the endpoint, `Content-Type: application/json`, `Accept: application/graphql-response+json, application/json`, body `{ query, variables?, operationName? }` (mutations use the same `query` key). `redirect: "manual"`.
- **Two error channels, both handled:** (1) HTTP 200 with a top-level `errors` array — the *normal* GraphQL path; return the whole JSON body (the `errors` are agent signal, not a junction failure); `isError: true` only when `errors` present AND `data` null/absent (partial data → `isError: false`). (2) Non-200 (401/403 auth-or-introspection-off, 400 malformed, 429/5xx) → typed `UpstreamError`/`isError`, cause scrubbed.

### Reuse junction's proven machinery (no new patterns)

- **Auth:** reuse `OpenApiAuthSchema` verbatim (apiKey/bearer/basic/oauth2) — GraphQL is just HTTP POST. GitHub → `bearer` (+ a default `User-Agent` via `defaultHeaders`, GitHub rejects requests without one); Shopify → `apiKey` header `X-Shopify-Access-Token`.
- **HTTP discipline:** lift from `openapi-client/http.ts` — 30 s timeout via `AbortController` with the timer kept armed through the full body read (slowloris guard), 1 MB streamed `RESPONSE_BYTE_CAP`, leak-safe errors built from `cause.constructor.name` (never `cause.message` — a fetch `TypeError` embeds the URL). The auth token/header **never** echoes into results/logs/errors; the upstream's `errors` array IS returned (agent's data, not junction's secret).
- **New cheap guard:** `maxQueryBytes` (default 100 KB) — reject pathological documents before sending.
- **Proxy/namespacing/toolFilter/credential-injection:** unchanged — GraphQL plugs into the existing `ToolProvider` → `createProfileProxy` path.

### Invariants / safety

- **Read-only profile is a real guarantee** — `toolFilter` deny `graphql_mutation` + provider rejects mutation-through-query + rejects subscription.
- **Introspection-disabled is graceful** — `graphql_schema` degrades; execution tools unaffected.
- **No secret/endpoint-token leakage** — same scrub discipline; only the upstream JSON body (data + errors) is returned.
- **Credential never spliced into the query document** — header-only (the agent authors `query`+`variables`; junction passes them through untouched).
- **Source-agnostic** — no vendor logic; one endpoint, one auth model.

### Out of scope (record deferrals in `docs/futures/`)

Per-field typed-tool generation (curated operation allowlist) · live `introspect`/`search`/`validate` discovery tools for huge schemas · query depth/complexity/**cost limiting** (the *upstream's* responsibility — GitHub/Shopify already enforce budgets; → `revisit-when.md`, trigger: an expensive endpoint/abusive agent) · query **batching** (array bodies — amplification vector; reject in v1) · **subscriptions** (need WebSocket/SSE) · multipart file uploads · variable validation against the cached schema · persisted queries.

### Proof of done

- `pnpm verify` with tests:
  - **operation-type enforcement** (the novelty): `graphql_query` rejects a `mutation` and a `subscription` doc → `invalid-args`; `graphql_mutation` rejects a `query`; `operationName` selects the right op in a multi-op doc; syntax error → `invalid-args`; `maxQueryBytes` exceeded → `invalid-args`/`response`-style error before any fetch.
  - **provider** (`createGraphQlProvider`): `listTools` returns exactly the 3 tools with correct inputSchemas; `callTool` POSTs the right body (query/variables/operationName) with injected auth header + defaultHeaders; a 200-with-`errors` body → returned verbatim with `isError` set per the data/errors rule; non-200 → typed error; the 1 MB cap + timeout behave (mirror the openapi http tests); **no auth token in any returned/logged string** (sentinel test).
  - `graphql_schema`: serves cached `schemaSdl`; with no cache, live-introspects (mock endpoint) → SDL; introspection failure → clear message, source still usable.
  - **migration**: the new additive `graphql` column (drizzle-kit generated, snapshot present); repos round-trip a `graphql` descriptor.
  - `platform add --kind graphql`: builds the descriptor, introspects+caches SDL at add (warn+proceed if introspection disabled); `--json`.
- `pnpm build`; `pnpm depcruise` (0 errors — `graphql-client` governed by the structural app/lib rule; `tsconfig.depcruise.json` maps `@junction/graphql-client` → src; **`graphql-client → core` only**); `pnpm quality` (0 clones — the http-discipline duplication with openapi-client is the rule-of-three *second* use; keep duplicated, don't add ignores to mask). SPDX on all new files. **`vitest.config.ts` alias for `@junction/graphql-client` → src** (the inc-18 green-but-blind lesson — add it in this same change).
- **MANUAL QA (orchestrator) — a real GraphQL API:** stand up a local GraphQL server (or use a public one / GitHub GraphQL with a token) → `platform add --kind graphql --endpoint …` (SDL cached) → `debug probe` shows the 3 tools → `debug call --tool graphql_schema` returns SDL → `debug call --tool graphql_query --args '{"query":"{ ... }"}'` returns real data → `debug call --tool graphql_query` with a `mutation` doc is **rejected**. Use a local server for determinism; note if a public API is also exercised.

---

## Part 2 — Implementation

### Step 1 — core: descriptor + schema + migration
- New `core/src/schema/graphql-connection.ts` (data only, no parser dep): `GraphQlConnectionSchema` = `{ endpoint: z.string().url(), auth: OpenApiAuthSchema.optional() (import & reuse), defaultHeaders: z.record(...).optional(), schemaSdl: z.string().optional(), maxQueryBytes: z.number().int().positive().optional() }`. Export type. (`PlatformKind` already includes `"graphql"`.)
- `core/src/schema/platform.ts`: add `graphql: GraphQlConnectionSchema.optional()` (parallel to `connection`/`openapi`).
- `core/src/db/schema.ts`: add additive nullable `graphql: text("graphql")` column to `platforms`. **Migration 0005 via `pnpm drizzle-kit generate`** (additive ADD COLUMN; snapshot + journal — never hand-author). `core/src/repositories/platforms.ts`: serialize on write (`JSON.stringify`), Zod-validate on read, exactly like the `openapi` column (`rowToPlatform`/`toPlatformRow`). Export `GraphQlConnectionSchema`/type from `core/src/index.ts`.

### Step 2 — new package `@junction/graphql-client`
Scaffold `packages/graphql-client/` mirroring `openapi-client/` (package.json name `@junction/graphql-client`, tsconfig with `"references":[{"path":"../core"}]`, tsdown config, SPDX). New dep: **`graphql`** (graphql-js, MIT) for `parse`, `getIntrospectionQuery`, `buildClientSchema`, `printSchema`. Files:
- `operation.ts` — `parse` the document, select the operation (operationName/first), return its type or an `invalid-args` error; enforce against the requested tool type; reject `subscription`.
- `http.ts` — POST executor: build headers (`Content-Type`/`Accept`/`defaultHeaders` + injected auth), body `{query,variables,operationName}`, `redirect:"manual"`, 30 s timeout, 1 MB streamed cap, leak-safe error mapping. **Lift the discipline from `openapi-client/http.ts`** (keep duplicated — 2nd use; note in futures that a 3rd HTTP provider triggers extracting a shared `fetchWithCaps`).
- `introspect.ts` — `getIntrospectionQuery()` POST → `buildClientSchema` → `printSchema` → SDL; typed error on failure.
- `provider.ts` — `createGraphQlProvider(connection, secret): ToolProvider`: `listTools` returns the 3 `ProviderTool`s; `callTool` dispatches by raw name (`graphql_query`/`graphql_mutation` → operation-guard + http; `graphql_schema` → cached SDL else live introspect). Synchronous construction (returns the provider; `buildProvider` wraps in `ok(...)` like OpenAPI).
- `index.ts` — narrow exports (`createGraphQlProvider`; any pure helpers tests need).

### Step 3 — wiring
- `cli/src/providers.ts` `buildProvider`: add `if (platform.kind === "graphql")` → guard `platform.graphql`, lazy-import `@junction/graphql-client`, `return ok(createGraphQlProvider(platform.graphql, secret))`.
- `cli/src/commands/platform.ts`: add the `kind === "graphql"` add-path — `--endpoint` (required, validated URL), auth flags (reuse the openapi `--auth-scheme/--auth-name/--auth-in/--auth-username` handling — factor or mirror), repeatable `--header k=v` → `defaultHeaders` (set a sane default `User-Agent`), introspect at add (→ cache `schemaSdl`; on failure `consola.warn` + proceed with it absent). Build `GraphQlConnectionSchema` → `PlatformSchema` → persist. `--json`.
- `tsconfig.depcruise.json`: map `@junction/graphql-client` → `packages/graphql-client/src`. `vitest.config.ts`: alias `@junction/graphql-client` → src.
- `mcp-server` `safeUpstreamMessage` / cli `formatUpstreamError`: confirm exhaustive over any reused `UpstreamError` kinds (no new kind expected; GraphQL errors fold into the `isError` result body).

### Step 4 — tests + skill + futures
Tests per Proof-of-done (operation enforcement is the priority suite). Update `junction-dev` skill (`platform add --kind graphql`, the 3 tools, read-only via toolFilter). `docs/futures/revisit-when.md`: GraphQL cost/depth limiting (trigger) + per-field typed tools (trigger: curated allowlist demand); `docs/futures/gotchas.md` if subtle (introspection-disabled handling; query/mutation enforced only via parse).

### Step 5 — verify, build, commit
`pnpm verify` + `pnpm quality` + `pnpm depcruise` + `pnpm build` (migration 0005 + snapshot in `core/dist/migrations`; new package builds). SPDX. Commit; push; PR base main.

---

## Review (background, after build)

- **`junction-mcp-contract` + `ce-correctness-reviewer`** (lead): operation-type enforcement is correct and not bypassable (multi-op docs, `operationName`, subscription rejection, query↔mutation mismatch); the 200-with-errors vs non-200 mapping; `isError` data/errors rule; `graphql_schema` cached-vs-live + graceful introspection failure.
- **`junction-credential-security`**: auth token never in results/logs/errors (sentinel); credential header-injected only, never spliced into the document; endpoint-in-error scrub.
- **`junction-package-boundary` + `junction-clean-code-reviewer`**: new `graphql-client → core` only; depcruise maps the new package; vitest alias added; SPDX; the http-discipline duplication is acceptable (2nd use) and not masked; thin cli edge.
- **`ce-data-migration-reviewer`**: migration 0005 is additive (ADD COLUMN), snapshot present, round-trips.
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)
**Visually testable — YES:** `platform add --kind graphql --endpoint …` → `debug probe` shows the 3 tools → `debug call --tool graphql_schema` returns SDL → `graphql_query` returns real data → a `mutation` through `graphql_query` is rejected. **QA'd by me:** drove a real/local GraphQL endpoint end-to-end; confirmed operation-type enforcement, no token leak, introspection-disabled graceful, migration round-trip. **Checklist:** 3 fixed tools, query/mutation split enforced via parse (read-only real), subscription rejected, SDL cached at add + graceful live fallback, auth reused + header-only, HTTP caps/timeout/scrub lifted, additive migration 0005, new package boundary + vitest alias, source-agnostic.

## User test gate
```bash
pnpm build
JUNCTION_HOME=/tmp/jt20 node packages/cli/dist/index.js init
# GitHub GraphQL (needs a token) or any GraphQL endpoint:
JUNCTION_HOME=/tmp/jt20 node packages/cli/dist/index.js platform add --id gh-gql --kind graphql \
  --endpoint https://api.github.com/graphql --auth-scheme bearer --header "User-Agent=junction"
JUNCTION_HOME=/tmp/jt20 node packages/cli/dist/index.js credential add --platform gh-gql --profile-name me  # paste token
JUNCTION_HOME=/tmp/jt20 node packages/cli/dist/index.js debug call --platform gh-gql --credential <id> --tool graphql_schema
JUNCTION_HOME=/tmp/jt20 node packages/cli/dist/index.js debug call --platform gh-gql --credential <id> \
  --tool graphql_query --args '{"query":"{ viewer { login } }"}'
```
Approve → next: Web UI, then OAuth.
