---
increment: 28
title: Web — probe + call (in-browser debug surface)
depends_on: [27]              # needs the merged web + profiles chrome; no new dep on 27's keys code
soft_after: [26]              # profiles route-row + setFilter chrome (already merged)
touches: [core, cli, web, ci] # NEW lib @junction/source-runtime + cli rewire + web probe surface + vitest/ci wiring
parallel_group: wave-28       # Slice A (extract+rewire) is BLOCKING; Slice B (web) fans out after A merges
---

# Method File 28 — Web: probe + call (in-browser debug surface)

> **The dogfood surface, in the browser.** Today a user can only exercise a source
> end-to-end from the CLI (`junction debug probe` / `junction debug call`, inc 17) or by
> standing up `mcp serve` + a real agent. This increment brings **probe** (list a source's
> tools) and **call** (invoke one tool, see the real result) into the web dashboard —
> **profile-scoped**, so the tools appear with the profile's **configured namespace +
> toolFilter applied**, exactly as the agent will see them through `mcp serve`. It answers
> *"what will profile X actually serve, and does this tool actually work?"* from the UI.
>
> **This is planned as a WAVE (mode A).** The provider-building + proxy wiring that both
> `cli` and `web` need is currently **trapped inside the `cli` app** (`packages/cli/src/providers.ts`),
> and `web` must not import `cli` (sibling apps). So the blocking core/shared slice is a
> **new lib `@junction/source-runtime`** — the 2nd app now needs this composition-root
> wiring, mirroring the inc-26 `@junction/platform-orchestration` extraction exactly. Then
> `web` (and the rewired `cli`) fan out.

---

## ⚠️ Decisions taken while the user was away (CONFIRM at the step-4 gate)

The user stepped away during the design conversation. I proceeded to **write the plan** (not
build — the build waits for the step-4 approval) taking the three recommended options. Each is
the architecturally-correct choice per `docs/behaviours/` and is called out here so it can be
overridden at the gate:

1. **Provider wiring → extract to a new shared lib `@junction/source-runtime`** (not copy-paste
   into web). *Architecture over expedience:* the security-critical secret-handling +
   provider-dispatch lives in **one** place, imported by both apps. Same precedent as
   `@junction/platform-orchestration`. Cost: a new package + a cli rewire slice (behaviour-preserving).
   — *The expedient alternative was:* copy `buildProvider`/`resolveCredentialSecret` into
   `web/src/server/probe.server.ts` + add the 3 client libs as web deps. Faster, but a 2nd
   divergent copy of secret code to hand-sync. **Rejected.**

2. **Probe/call is PROFILE-scoped** (through `createProfileProxy`), not platform-scoped like the
   CLI `debug`. Matches STATE.md's *"call a tool through a profile"* framing + `mcp serve`
   semantics (namespaced + toolFilter-applied tools = the honest dogfood). Attaches to the
   **profiles page** route-row ⋯ menu. — *Platform-scoped (CLI-`debug`-parity) was the simpler
   alternative;* it shows a source in isolation (raw tools, no filter). **Deferred** — can be
   added later as a platforms-page action if wanted.

3. **Tool args entered as a raw JSON textarea** (validated as a JSON object server-side, same as
   CLI `--args`), **not** a schema-driven form. Ships this increment; a JSON-Schema→form renderer
   is a clean, separable follow-up (recorded in Out of scope).

If any of these should change, say so at the gate and I'll revise before the builder starts.

---

## Part 1 — Spec (what & why)

### Goal

From the web **Profiles** page, for a selected profile's route (a `SourceMeta`):

- **Probe** — list the tools that route exposes **through the profile** (namespaced with the
  profile's configured `toolNamespace`, with the route's `toolFilter` applied). Shows the
  agent-visible **namespaced** name (primary) and the **raw** upstream name (recovered — see
  the raw-name note below). This is `createProfileProxy(...).listTools()` narrowed to the one
  source (or the whole profile — see the scoping note below).
- **Call** — invoke **one** namespaced tool with a JSON args object and render the real
  `content` + `isError`. This is `createProfileProxy(...).callTool(namespacedName, args)`.

**Proof:** against a live local no-auth OpenAPI source added to a profile, the profiles page
**Probe** action lists `getGreeting` (namespaced, e.g. `pub_public__getGreeting`) and **Call**
on it with `{}` returns the real 200 body — **with no credential**, **no secret anywhere in the
response/DOM/SSR HTML**, and the provider is closed after each call. A credentialed MCP source in
a profile probes + calls the same way.

### Scoping decision inside "profile-scoped" (builder: implement the per-source variant)

`createProfileProxy` operates on a **profile's whole SourceRef list**. Two honest ways to expose
per-route probe/call:

- **(chosen) Per-source, profile-context.** The UI action is on ONE route row. The server-fn
  builds a `createProfileProxy` over **just that one SourceRef** (a single-element source list),
  so `listTools()` returns exactly that route's namespaced+filtered tools and `callTool()` routes
  to it. This is the tightest match to "probe this route" and keeps the result small/legible. The
  namespace + filter are the route's **real configured** ones (not derived) — the key honesty win
  over the CLI `debug` probe.
- (not chosen) Whole-profile probe (all routes at once). Larger output, and "call" would need the
  user to pick among all namespaces. Deferred; the per-source variant composes up to this later if
  wanted (loop the profile's sources).

So the server-fns take **`{ profileId, namespace }`** (the namespace uniquely identifies the route
within the profile) → resolve the profile → find the matching SourceRef → build a single-source
`createProfileProxy` → `listTools()` / `callTool()`.

### Raw-name recovery (FEASIBILITY FIX — the proxy discards the raw name)

`createProfileProxy(...).listTools()` returns `ProviderTool[]` whose `name` has been **overwritten**
with the *namespaced* name (`proxy.ts:180` — `{ ...t, name: nameResult.value }`); `ProviderTool` has
no separate raw field, so the raw upstream name is gone after the proxy runs. The CLI `debug probe`
can show both `{raw, namespaced}` only because it calls `provider.listTools()` **directly** and
namespaces for display itself — it does *not* go through the proxy.

**Decision (chosen): recover the raw name by splitting the namespaced name on the first `__`.** The
namespace prefix is known (it's the route's `toolNamespace`), so `splitNamespacedName(namespaced)`
(already in `packages/core/src/sources/naming.ts`, the same helper the proxy's `callTool` uses)
returns `{ namespace, tool: raw }`. The server-fn maps each proxied tool to
`{ namespaced: t.name, raw: splitNamespacedName(t.name).tool, description: t.description }`. This
keeps the honest "through the proxy" path (toolFilter + real namespace applied by core, not
re-implemented web-side) **and** recovers the raw name for display — no bypass, no duplicated filter
logic. (Rejected: (a) drop raw from the UI — loses a useful column; (c) bypass the proxy and call
`buildProvider` directly like CLI `debug` — would force re-implementing toolFilter web-side and
undermine the dogfood rationale.)

### What exists vs the gap (verified in the codebase)

- **CLI already has the wiring** (`packages/cli/src/providers.ts`): `buildProvider(platform, secret, paths)`
  (dispatch-by-kind, lazy-imports mcp-client/openapi-client/graphql-client, `createCliProvider` from
  core), `resolveCredentialSecret(repos, paths, credentialId?)`, and `makeResolveProvider(repos, store,
  paths, opts)` (the SourceRef→provider resolver injected into `createProfileProxy`). `createProfileProxy`
  itself is in **core** (`packages/core/src/sources/proxy.ts`).
- **The gap:** all of `buildProvider`/`resolveCredentialSecret`/`makeResolveProvider` live in the **cli
  app**. `web`'s `package.json` depends only on `@junction/core` + `@junction/platform-orchestration`;
  the provider factories (`createMcpProvider` etc.) are in the client libs web doesn't depend on. **Web
  cannot build a provider today.** There is **no** probe/call/ToolProvider code in web (verified — only
  reserved badge/CSS comments "for inc 28+").
- **`SourceMeta` lacks `credentialId`** (`data.server.ts:162` — it carries `platform` + resolved
  `credentialAccount`, having dropped the raw id). The web probe/call resolves the SourceRef (and thus
  its `credentialId`) **server-side** from `(profileId, namespace)`; the client never sees a credentialId.
- **`adaptToMcpHandlers`** (also in `cli/providers.ts`) imports `McpServerHandlers` from `@junction/mcp-server`.
  It is a **serving** concern (proxy→MCP-handler shape) used only by `serve.ts`/`mcp.ts`. **It stays in cli**
  — it does not move to the lib (keeps the lib free of an mcp-server edge; the composition root for serving
  belongs in the app). The lib gets only the pure source-running primitives.

### The change (two slices)

**Slice A — `@junction/source-runtime` (blocking core/shared slice) + cli rewire.**
1. New lib `packages/source-runtime/` (template: `@junction/platform-orchestration`). Deps:
   `@junction/core`, `@junction/mcp-client`, `@junction/openapi-client`, `@junction/graphql-client`,
   `neverthrow`. tsdown build; `exports` → `dist/index.js` + `dist/index.d.ts`; `license: AGPL-3.0-only`;
   `private: true`.
2. **Move verbatim** (behaviour-preserving) from `cli/src/providers.ts` → the lib:
   `buildProvider`, `resolveCredentialSecret` (+ its `ResolveCredentialError` type), `makeResolveProvider`
   (+ `ProviderResolution` type). Keep the lazy `import("@junction/mcp-client")` etc. inside the branches.
   Re-export `createProfileProxy` is NOT needed (it's core; consumers import it from core directly).
3. **Keep in cli:** `adaptToMcpHandlers` (the only thing needing `@junction/mcp-server`). `cli/src/providers.ts`
   becomes a thin file holding just `adaptToMcpHandlers`, re-exporting the moved fns from the lib for its own
   call sites (or update the imports in `debug.ts`/`serve.ts`/`mcp.ts` to import from `@junction/source-runtime`
   directly — builder's choice, whichever keeps the diff smallest; **`mcp serve` + `junction serve` + `debug`
   must stay byte-identical in behaviour**).
4. Wiring: add `@junction/source-runtime` to the **vitest alias map** (both projects — inc-18 gotcha),
   add it as a cli dep, and confirm depcruise stays green (a lib importing core+libs is legal; the lib must
   NOT import cli/web/mcp-server — see the boundary note).

**Slice B — web probe/call surface (leaf, fans out after A merges).**
5. `web/package.json` += `@junction/source-runtime` (workspace:*).
6. New **server-only** `packages/web/src/server/probe.server.ts` (imports `@junction/core` +
   `@junction/source-runtime` — server-only, satisfies the leak gate as long as it's referenced only
   inside a `.handler()`):
   - **repos + store helper (FEASIBILITY FIX — no reusable public helper exists).** `withReposAndStore`
     is **private** in `mutations.server.ts` **and it THROWS on store failure** (`mutations.server.ts:30-31`)
     — do NOT reuse it (a throw violates the "never a throw to the client" invariant). Instead, build the
     store **gracefully-nullable** inside `probe.server.ts`: `const store = storeResult.isOk() ? storeResult.value : null`
     (mirroring `mcp.ts:141`), then pass `store` (which may be `null`) into `makeResolveProvider`. A `null`
     store means the credentialed path resolves `secret = null` → a credentialed source will fail to resolve
     and the proxy returns an empty list / `tool-not-found`, which the server-fn maps to a clean error string
     — never a throw. (Public no-auth sources never touch the store, so they work regardless.) Use `getDb()`
     from `shared.server.ts` for repos and `createCredentialStore(getPaths())` for the store (the exact pair
     `mutations.server.ts:29` already uses). *Alternatively* the builder may promote a
     `withReposAndStoreNullable` into `shared.server.ts` — but the null-graceful semantics above are the
     requirement, not the mutations-style throw.
   - `probeSource({ profileId, namespace })` → resolve profile (repos) → find the SourceRef by `namespace`
     (if none → `{ ok:false, error:"route not found in profile" }`) → **guard `sourceRef.enabled`** (if
     disabled → `{ ok:false, error:"this route is disabled — enable it to probe" }`; a disabled source yields
     an empty proxy, so guard explicitly rather than show a confusing empty list) → build a **single-source**
     `createProfileProxy([sourceRef], makeResolveProvider(repos, store, paths, {logPrefix:"probe"}))`
     → `listTools()` → map each tool to `{ namespaced: t.name, raw: splitNamespacedName(t.name).tool, description: t.description }`
     (raw recovered per the raw-name note) → **`close()` semantics: per-call proxy, the proxy closes each
     provider in its own `finally` (connect-per-call v1, verified `proxy.ts:183-186` / `240-243`) — web adds
     NO long-lived handle to leak**. Returns `{ ok:true; namespace; tools } | { ok:false; error }`.
   - `callSourceTool({ profileId, namespace, toolName, argsJson })` → same profile/SourceRef resolve + enabled
     guard + proxy build → parse `argsJson` to a JSON **object** (reject non-object/invalid → `{ ok:false, error }`,
     never a throw) → `callTool(toolName, args)` (toolName is the **namespaced** name; the proxy splits it and
     routes) → `{ ok:true; content; isError } | { ok:false; error }`.
   - Errors mapped to **strings** via a `formatUpstreamError`-equivalent exhaustive switch (copy the shape
     from `cli/commands/debug.ts:27-68` — **do not** leak raw `UpstreamError.kind` unions to the UI; exhaustive
     switch, **no `default`** on the exhaustive arm — the never-guard, per `docs/rules/`). **The switch must
     cover EVERY `UpstreamError.kind` the proxy can emit** (incl. `tool-not-found`, which the proxy returns
     identically for "no such tool" / "denied by filter" / "namespaced name too long" — deliberate
     non-disclosure; map it to ONE safe string like `"tool not found"`, do not try to distinguish the cases).
     If a kind is missing the exhaustive `never`-guard will fail typecheck — that's the gate working.
   - **SECRET DISCIPLINE (load-bearing):** the secret is resolved inside `makeResolveProvider` and flows only
     into the provider transport. Probe returns tool names only; call returns upstream `content` + `isError`
     only. **Never** return/serialize/log the secret, secretRef, or a request URL. (OpenAPI provider already
     returns leak-safe `"status\nbody"` — inc 15.)
7. New `packages/web/src/server/probe.functions.ts`: `probeSourceFn` (POST) + `callSourceToolFn` (POST),
   each `.validator()` (pure: `requireString` on profileId/namespace/toolName; `argsJson` is a string, default
   `"{}"`) → `.handler(async ({data}) => { assertLocalHost(); return <server fn>(data) })`. Import
   `assertLocalHost` + `requireString` from **`./fn-guards.server.js`** (that's where they live, not
   `host-guard.ts`). **The server helper must be referenced INSIDE `.handler()`, never at module scope** (the
   inc-27 client-graph-leak gotcha). Re-export only the metadata result **types** for the route.
8. **Web UI (profiles page)** — add two route-row ⋯-menu actions ("**Probe tools**", "**Call a tool**"),
   scoped to the selected profile + clicked `SourceMeta`:
   - **Disabled-route guard (UI):** `SourceMeta.enabled` is on the client — if the clicked route is disabled,
     the ⋯ Probe/Call actions should be disabled (or the dialog shows "enable this route to probe") rather than
     firing a server-fn that returns the "disabled" error. Belt-and-suspenders with the server-side guard in step 6.
   - **Probe dialog:** on open, calls `probeSourceFn` → renders the tool list (namespaced name via `MonoChip`,
     raw name + description via `MonoCode`/plain). Loading + empty + error states (`states.tsx` primitives).
     A "Call" affordance per tool row that opens the Call dialog pre-filled with that tool name (nice-to-have;
     acceptable to just have a separate Call action).
   - **Call dialog:** tool name (pre-filled or a `Select` of probed tools if probe ran; else a text input),
     a **monospace `Textarea`** for the JSON args (default `{}`), a "Call tool" submit → `callSourceToolFn` →
     render `content` (pretty-printed JSON in a scrollable `<pre>`/`overflow-x-auto` container) + an `isError`
     `StatusBadge` (`auth-failed`/`configured` taxonomy — reuse existing; do NOT invent a token). Errors from
     the server-fn → inline error + `toast.error`. Success → render result (no `router.invalidate()` needed —
     probe/call are **reads**, they mutate no persisted state).
   - Follow the self-contained-dialog pattern (own `useState` for open/loading/result/error). Import all chrome
     from the `ui/index.ts` barrel. `// No @junction/core import.` header holds.
9. **Gates wiring:** the profiles route is already in `web-smoke.mjs`'s route list; the new server modules are
   server-only so they must **not** appear in the client bundle (leak gate) or SSR HTML (smoke gate). The leak
   gate has no literal `source-runtime` token in its denylist, but it lists `@junction/core` (which source-runtime
   transitively imports) + `secretRef`/`better-sqlite3` — so a leaked server module is caught **transitively**;
   still verify the client bundle after build. Add a `probe.server.test.ts`. No new CSS tokens (reuse existing) —
   if any is needed, define it in `app.css` (css-tokens gate).

### Security / robustness invariants (the review gate checks these)

- **Secret never leaves the process / never appears in any web output** — not in the server-fn return, the
  client bundle, the SSR HTML, the DOM, or a toast. The `web:leakcheck` (client bundle) + `web:smoke` (SSR HTML)
  gates enforce `secretRef`/`@junction/core`/`better-sqlite3` absence; the review verifies no plaintext secret
  path.
- **Server-only-core boundary held (triple guard):** `probe.server.ts` imports core + source-runtime; it is
  reached **only** via a `.handler()` body in `probe.functions.ts`; the route imports only `probe.functions.ts`
  (types + fns). The inc-27 trap: **never** pass a server-only fn as a module-scope factory arg — reference it
  inside `.handler()`.
- **`assertLocalHost()` inside every `.handler()`** (after the pure validator). Probe/call are POST server-fns.
- **Provider closed on every path** — connect-per-call v1: `makeResolveProvider` builds a fresh provider per
  `listTools`/`callTool` and `createProfileProxy` closes it in its own `finally` (existing core behaviour). The
  web helper adds no long-lived handle. (The inc-11 leaked-connection hang is already guarded in core; do not
  re-introduce a handle web-side.)
- **`--args`/`argsJson` parsing rejects non-objects cleanly** → a typed `invalid-args`-style error string, never
  a throw to the client.
- **`mcp serve` / `junction serve` / `junction debug` stay byte-identical** after Slice A's extraction —
  behaviour-preserving move; their existing tests pass unchanged.
- **No new package edges beyond the DAG:** `source-runtime` (lib) imports core + mcp-client + openapi-client +
  graphql-client (all libs — legal lib→lib). It must **not** import cli/web/mcp-server. `web`→`source-runtime`
  is app→lib (legal). depcruise stays 0.

### Boundary note — why `adaptToMcpHandlers` stays in cli

The depcruise `libs-import-only-core` rule technically *permits* a lib to import `mcp-server` (mcp-server is
classed as a lib). But `adaptToMcpHandlers` bridges a proxy to the **serving** handler shape — a composition
concern that belongs to the serving apps (`serve.ts`/`mcp.ts`), not to a source-running lib. Keeping it in cli
keeps `source-runtime` free of an mcp-server edge and single-purpose (build providers, resolve secrets, resolve
sources). This is a deliberate judgment, recorded here.

### Proof of done

**Slice A:**
- `pnpm verify` green with the moved fns' existing tests relocated/passing against the lib. **Test-coverage
  reality (FEASIBILITY FIX):** only `buildProvider` + `resolveCredentialSecret` have direct unit tests
  (`packages/cli/src/providers.test.ts` — move these with the code). `makeResolveProvider` has **no direct
  unit test today** — it's covered only indirectly via `serve.test.ts` (which **stays in cli** and must pass
  unchanged). So don't hunt for a `makeResolveProvider` test to move; Slice B's `probe.server.test.ts` becomes
  its first direct coverage from a 2nd consumer. `mcp serve` + `junction serve` + `debug` regression tests pass
  **unchanged**.
- `pnpm build` (tsdown builds the new lib); `pnpm depcruise` 0 errors (planted-import check: `source-runtime`→core
  ok, →mcp-client/openapi/graphql ok, →cli/web/mcp-server **blocked**); `pnpm quality` (jscpd) not worsened —
  the extraction should **reduce** duplication (one copy shared by two apps), not add. SPDX on new files.
- vitest alias map has `@junction/source-runtime` in **both** projects.

**Slice B:**
- `pnpm verify` (incl. `verify:web` = build → leakcheck → css-tokens → smoke → web tests → typecheck) green.
- `probe.server.test.ts`: probe lists tools for a single-source profile over an in-memory MCP source AND an
  OpenAPI source; call invokes a tool → real result; **assert no secret / no request URL in the returned shape**;
  bad `argsJson` → clean error; missing profile/namespace → typed error; unsupported/failed source → error string
  (not a throw).
- Leak gate: `@junction/core`/`source-runtime`/`secretRef` **absent** from `dist/client/**`. Smoke gate: absent
  from SSR HTML of `/profiles`.
- **MANUAL QA (orchestrator, `junction-web-verify` skill) against the REAL running server** (per
  `docs/behaviours/verify-the-artifact.md` — a green gate is not a working product):
  - Seed `/tmp/jt28`: a local no-auth OpenAPI source + a credentialed MCP source, each added to a profile.
  - `junction web` → Profiles → select profile → route ⋯ → **Probe tools** → tool list renders with the profile's
    real namespace (`MonoChip`) + raw name; toolFilter'd tools absent if a filter is set.
  - **Call a tool** with `{}` → real 200 body / MCP content rendered; `isError` badge correct.
  - **Adversarial secret check:** inspect the POST response body, the rendered DOM, the SSR HTML (`curl`), and the
    HAR — the credential/secret appears **nowhere**; only tool data. Repeat for the credentialed MCP source.
  - Bad JSON in the args textarea → inline error, no crash. A source whose upstream is down → clean error string.

### Out of scope (record in the method file, defer honestly)

- **Schema-driven arg form** (JSON-Schema → typed fields). `ProviderTool.inputSchema` is available; a renderer is
  a separable follow-up. Textarea ships now. → note in `docs/futures/revisit-when.md` if the user wants it tracked.
- **Whole-profile probe** (all routes at once) — per-source variant ships; loop-up composes later.
- **Platform-scoped probe** (CLI-`debug` parity on the platforms page) — deferred; add later if wanted.
- **Saving/replaying calls, call history, request timing** — no persistence this increment (probe/call are reads).
- **Live badges** (the reserved "live-probed" badge states) — this increment provides on-demand probe, not a
  background liveness poller; the badge taxonomy stays `configured` (stored, not continuously probed). The
  StatusRail live-pulse revisit-when entry is untouched.

---

## Part 2 — Implementation

### Wave shape

```
Slice A (BLOCKING core/shared)         Slice B (leaf — after A merges)
─────────────────────────────         ──────────────────────────────
new lib @junction/source-runtime       web/package.json += source-runtime
  ← move buildProvider,                 probe.server.ts  (server-only)
    resolveCredentialSecret,            probe.functions.ts
    makeResolveProvider from cli        profiles.tsx: ⋯ Probe / Call dialogs
cli/providers.ts → keeps only           probe.server.test.ts
  adaptToMcpHandlers; rewire imports
vitest alias + depcruise + cli dep
```

`touches` overlap: Slice A mutates `core`-adjacent wiring (`cli`, new lib, `ci`); Slice B mutates `web`. They
**do not both write the same files**, but **B hard-depends on A** (web imports the new lib) — so this is a
**serial two-step within the increment**, not two simultaneous slices. Build A, `pnpm verify`, **merge A**,
then build B. (Per `_waves.md`: a real dependency chain stays serial — don't manufacture parallelism.) Reviews
run per-slice.

### Slice A — steps

1. Scaffold `packages/source-runtime/` from the `platform-orchestration` template (package.json, `tsconfig.json`
   with `references` to core + the 3 client libs, `tsdown.config` if the sibling has one, `src/index.ts`). SPDX header.
2. Move `buildProvider`, `resolveCredentialSecret` (+`ResolveCredentialError`), `makeResolveProvider`
   (+`ProviderResolution`) from `cli/src/providers.ts` into `src/` files in the lib; export from `src/index.ts`.
   Preserve the lazy imports + secret discipline comments verbatim.
3. `cli/src/providers.ts`: delete the moved fns, keep `adaptToMcpHandlers`. Update `debug.ts` / `serve.ts` /
   `mcp.ts` to import the moved fns from `@junction/source-runtime` (and `adaptToMcpHandlers` from the local
   `providers.js`). Add `@junction/source-runtime` to `cli/package.json` deps.
4. Move the corresponding tests to the lib (or point them at the new import path). Add the vitest alias
   (`vitest.config.ts`, both projects — `source-runtime` → `packages/source-runtime/src/index.ts`).
5. `pnpm build` → `pnpm verify` → `pnpm depcruise` (planted-import matrix) → `pnpm quality`. Commit on a
   `docs/method-28` sibling branch (or `feat/source-runtime`), PR, CI, **merge** before Slice B.

### Slice B — steps

6. `web/package.json` += `@junction/source-runtime`. `probe.server.ts` + `probe.functions.ts` +
   `probe.server.test.ts` per the spec. Profiles-page dialogs + ⋯-menu actions.
7. `pnpm verify` (incl. `verify:web`). Clean stray `src/**/*.js` before `vite build` (inc-24.5 gotcha).
8. Orchestrator manual QA (above). Reviews. Fix. PR, CI, merge.

### Reviewers (per slice, parallel — relevance-selected)

- **Slice A:** `junction-package-boundary` (LEAD — new lib in the DAG; core→nothing, lib→core+libs, lib↛app;
  the extraction genuinely de-duplicates) · `junction-clean-code-reviewer` (thin edges, SPDX, single-purpose,
  no behaviour change) · `ce-correctness-reviewer` (`mcp serve`/`serve`/`debug` byte-identical after the move;
  the MCP/OpenAPI `ResultAsync` asymmetry preserved).
- **Slice B:** `junction-web-reviewer` (LEAD — server-only-core boundary, metadata/leak-safety, design-token
  discipline, a11y, component tests; **grep the BUILT client CSS/bundle, not source** — the recurring "green but
  blind" trap) · `junction-credential-security` (secret never in any web output; connect-per-call closes; no
  store touch on the no-credential path) · `junction-package-boundary` (web→source-runtime is app→lib; no
  client-graph leak of the server-only module — the inc-27 factory-arg trap) · `ce-correctness-reviewer`
  (single-source proxy build correct; `argsJson` non-object rejected; error mapping exhaustive) ·
  `junction-mcp-contract` (namespaced name matches what `mcp serve` would emit for that route; toolFilter applied
  identically to the proxy). Then `/ce-simplify-code` on each diff.

---

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** on the Profiles page, a route's ⋯ menu → **Probe tools** lists the profile's
namespaced+filtered tools, and **Call a tool** with a JSON args object returns the real upstream result — for a
public no-auth source and a credentialed MCP source. **QA'd by me:** drove the real running `junction web` server
(`junction-web-verify`), probed + called both a public OpenAPI and a credentialed MCP source through a profile,
and adversarially confirmed the secret appears nowhere in the response/DOM/SSR-HTML/HAR; provider closed each
call; `mcp serve`/`serve`/`debug` unchanged after the extraction. **Checklist:** new `@junction/source-runtime`
lib (buildProvider + resolveCredentialSecret + makeResolveProvider moved, one shared copy); cli rewired
byte-identically; `adaptToMcpHandlers` correctly stays in cli; web probe/call **profile-scoped** (real namespace
+ toolFilter, not derived); JSON-args textarea validated as an object; secret/URL never in any web output;
server-only-core boundary held (no client-graph leak); connect-per-call closes; depcruise DAG clean
(lib→core+libs, lib↛app, web→lib); no new CSS tokens; probe/call are reads (no persistence).

## User test gate

```bash
pnpm build
JUNCTION_HOME=/tmp/jt28 node packages/cli/dist/index.js init
# add a public no-auth OpenAPI source + a credentialed MCP source, put each in a profile:
JUNCTION_HOME=/tmp/jt28 node packages/cli/dist/index.js platform add --id pub --kind openapi \
  --display-name "Public API" --spec-url <no-auth-spec-url>
JUNCTION_HOME=/tmp/jt28 node packages/cli/dist/index.js profile create --name work
JUNCTION_HOME=/tmp/jt28 node packages/cli/dist/index.js profile add-source --profile work --platform pub
JUNCTION_HOME=/tmp/jt28 node packages/cli/dist/index.js web --open
# → Profiles → select "work" → route ⋯ → Probe tools (lists namespaced tools)
#   → Call a tool → args {} → real response, no credential, no secret in output.
```
Approve → increment 29 (distribution — publish `junction` + the install story).
