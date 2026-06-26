# Method File 18 — OpenAPI base-URL resolution (relative servers) + early validation

> **junction can't call a spec whose `servers` URL is relative — which is most real specs.** The canonical petstore declares `servers: [{"url": "/api/v3"}]`; junction's `resolveBaseUrl` only accepts absolute `http(s)://…` and returns `null` → "no base URL", surfacing as a confusing failure at **call time** even though `platform add` "succeeded". Per the OpenAPI spec a relative server URL resolves against the **document's own location**, so a spec fetched from `https://petstore3.swagger.io/api/v3/openapi.json` has base `https://petstore3.swagger.io/api/v3`. This increment resolves relative server URLs against the spec's fetch URL **at `platform add`** (storing an absolute `baseUrl`), and **validates base-URL resolvability there** so an un-callable spec fails early with a clear message.
>
> **Builder:** Sonnet. Small, focused.

---

## Part 1 — Spec (what & why)

### Goal

Adding an OpenAPI platform whose spec uses a **relative** `servers` URL works with no `--base-url`: junction resolves it against the spec URL and stores the absolute base URL. A spec from which **no** base URL can be determined fails at `platform add` (not at call time) with an actionable message. Proof: `platform add --kind openapi --spec-url https://petstore3.swagger.io/api/v3/openapi.json` (no `--base-url`) → `debug call --platform petstore --tool getInventory` returns a real response from the live petstore API.

### Current behavior vs the gap

- `platform add` (openapi) sets `baseUrl` **only** from `--base-url` (`platform.ts:251`); it never consults the spec's `servers`.
- At call/serve time, `resolveBaseUrl` (`openapi-client/http.ts:62-84`) prefers `connection.baseUrl`, else `servers[0].url`, but **rejects any non-absolute URL** (`http.ts:76`: `if (!/^https?:\/\//i.test(url)) return null`).
- **Gap:** a relative server URL (`/api/v3`) → `null` → `no base URL` error, raised at the first tool call. The original spec **fetch URL** (which the relative URL should resolve against) is known only at `platform add` time — by serve/debug time the connection's spec is inline (`{from:"inline", document}`), so the origin is lost. Resolution therefore belongs at **add time**.

### The change

1. **New `resolveSpecBaseUrl(schema, specSourceUrl, override?)`** in `openapi-client` (exported): returns `Result<string, SpecBaseUrlError>` — the **absolute** base URL (trailing slash stripped), or a typed error:
   - `override` (the `--base-url`) present → validate it's an absolute `http(s)` URL → return normalized (else `invalid-base-url`).
   - else `servers[0].url`:
     - absolute `http(s)` → normalized.
     - **relative** (no scheme) → `new URL(serverUrl, specSourceUrl).toString()` → normalized. (Resolves `/api/v3` against the spec URL → `https://petstore3.swagger.io/api/v3`.)
     - contains server-variable templating (`{`…`}`, e.g. `https://{host}/v1`) → `base-url-has-variables` (we don't substitute — caller passes `--base-url`).
   - no `servers` / empty / blank url → `no-base-url`.
2. **`platform add` uses it:** replace `baseUrl: args["base-url"]` with `resolveSpecBaseUrl(schema, specUrl, args["base-url"])`. On `Ok` → store the absolute `baseUrl` in the descriptor. On `Err` → `reportError` with a clear, kind-specific message (early validation; no un-callable platforms persisted).
3. **Runtime unchanged:** `http.ts resolveBaseUrl` stays (still prefers `connection.baseUrl`, which is now always populated for newly-added platforms; keeps the absolute-`servers` fallback for platforms added before this change). No new runtime path; relative resolution is an add-time concern.

### Invariants / edges

- **Stored `baseUrl` is always absolute** (satisfies `OpenApiConnectionSchema.baseUrl = z.string().url()`), so serve/debug hit `connection.baseUrl` directly.
- **`--base-url` still wins** (explicit override) and is itself validated absolute.
- **Server-variable templating is out of scope** — `{var}` servers require `--base-url` (documented; deferred to a later increment if demand appears).
- **Spec source is always a URL today** (`platform add` requires `--spec-url`), so a relative server URL is always resolvable. (If `--spec-file` is ever added, a relative server with no fetch origin → `no-base-url` → require `--base-url`. Note it.)
- **No secret/URL leakage** — base URL is platform config, not a secret; it's already shown in `platform list`. Unchanged.

### Proof of done

- `pnpm verify` with tests:
  - `resolveSpecBaseUrl`: override (absolute ok / non-absolute → `invalid-base-url`); absolute server URL passes through normalized; **relative server URL resolves against the spec URL** (`/api/v3` + `https://petstore3.swagger.io/api/v3/openapi.json` → `https://petstore3.swagger.io/api/v3`); no servers → `no-base-url`; `{var}` server → `base-url-has-variables`; trailing slash stripped.
  - `platform add`: a spec with a relative server URL stores the resolved absolute `baseUrl` (no `--base-url` needed); a spec with no servers and no `--base-url` → **fails at add time** with the actionable message; `--base-url` override still honored.
- `pnpm build`; `pnpm depcruise` (0 errors); `pnpm quality` (0 clones). SPDX on any new file. New export wired through `openapi-client/src/index.ts`.
- **MANUAL QA (orchestrator) — the real, live petstore:** `platform add --id petstore --kind openapi --spec-url https://petstore3.swagger.io/api/v3/openapi.json` (**no `--base-url`**) → `platform list --json` shows an absolute `baseUrl` → `debug call --platform petstore --tool getInventory --args '{}'` returns a real response from the live API. (Per the standing directive to test against real specs end-to-end.)

### Out of scope

- Server-variable substitution. Per-operation `servers` overrides. `--spec-file` ingestion. Large-spec `--tag/--path` selection + `platform refresh` (now increment 19). Re-resolving base URLs for platforms added before this increment (they keep working via the absolute-`servers` runtime fallback or an explicit `--base-url`).

---

## Part 2 — Implementation

### Step 1 — `resolveSpecBaseUrl` (openapi-client)

New function (e.g. in `openapi-client/src/base-url.ts`, or alongside `http.ts` — keep single-purpose) exported from `openapi-client/src/index.ts`. Typed `SpecBaseUrlError` union (`no-base-url` | `invalid-base-url` | `base-url-has-variables`). Pure (no I/O). Normalize via `new URL(...)` + strip trailing `/`. Reuse a small `isAbsoluteHttpUrl`/normalize helper shared with `http.ts`'s existing `resolveBaseUrl` if it reduces duplication (don't force it — rule of three).

### Step 2 — wire into `platform add`

In `platform.ts` openapi branch: after `extractTools` succeeds, call `resolveSpecBaseUrl(schema, specUrl, args["base-url"])`; map `Err` → `reportError` (kind-specific: no-base-url → "could not determine a base URL from the spec's `servers`; pass --base-url"; has-variables → "the spec's server URL uses variables; pass --base-url"; invalid-base-url → "--base-url must be an absolute http(s) URL"). On `Ok`, pass the absolute value as `baseUrl` into `OpenApiConnectionSchema.safeParse({...})`.

### Step 3 — tests + skill

Per Proof-of-done. Add a real-spec note to the `junction-dev` skill: OpenAPI platforms with relative `servers` no longer need `--base-url`; when to pass it (server variables / spec without servers).

### Step 4 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` + `pnpm build`. SPDX. `docs/futures/gotchas.md`: relative-server-URL resolution (resolve against spec fetch URL at add-time; runtime can't because the origin is gone once the spec is inlined) + server-variable templating deferred. Commit; push; PR base main: "feat(openapi): resolve relative server URLs + validate base URL at platform add (increment 18)".

---

## Review (background, after build)

- **`ce-correctness-reviewer`** (lead): `resolveSpecBaseUrl` relative-resolution is correct (`new URL(relative, specUrl)` yields the right origin+path; trailing-slash normalization; the `{var}` and no-servers branches); `platform add` maps every error kind to a clear message and never persists an un-callable platform; `--base-url` override precedence intact.
- **`junction-clean-code-reviewer` + `junction-package-boundary`**: new function placed in openapi-client (lib), exported cleanly; cli imports it (app→lib, legal); no new edges; typed errors; SPDX; pure (no I/O in the resolver).
- **`junction-mcp-contract`** (light): a platform added this way actually lists+calls tools through serve/debug (the stored absolute baseUrl flows to `resolveBaseUrl`).
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** add the live petstore with no `--base-url`, `platform list` shows an absolute `baseUrl`, `debug call --tool getInventory` returns a real response; a spec with no servers fails at `platform add` with a clear message. **QA'd by me:** drove the real live petstore end-to-end (add → list → call) with no `--base-url`; confirmed early-validation failure for a no-servers spec; reviews addressed. **Checklist:** relative `servers` resolved against the spec URL at add-time, absolute `baseUrl` stored, `--base-url` override validated + wins, no-servers/`{var}` → early actionable error, runtime path unchanged, no un-callable platform persisted.

## User test gate

```bash
pnpm build
JUNCTION_HOME=/tmp/jt18 node packages/cli/dist/index.js init
# real, live petstore — NO --base-url:
JUNCTION_HOME=/tmp/jt18 node packages/cli/dist/index.js platform add --id petstore --kind openapi \
  --display-name Petstore --spec-url https://petstore3.swagger.io/api/v3/openapi.json
JUNCTION_HOME=/tmp/jt18 node packages/cli/dist/index.js platform list --json          # baseUrl is absolute
JUNCTION_HOME=/tmp/jt18 node packages/cli/dist/index.js debug call --platform petstore --tool getInventory --args '{}'
```
Approve → increment 19 (large-spec `--tag/--path` selection + `platform refresh`).
