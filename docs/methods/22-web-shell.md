# Method File 22 — Web shell + localhost server (read-only dashboard)

> **junction's first browser surface.** Turn the placeholder `@junction/web` into a **TanStack Start v1** app (Vite + Nitro node server) that reads the existing `@junction/core` and renders a **read-only** management dashboard — platforms, credentials (metadata only), profiles+sources. Launched by a new `junction web` command, **bound to 127.0.0.1 only**, no auth (single-user, local). This increment lands the whole frontend stack at the lowest risk (no mutations) and sets up the trust model + a callback-ready server that OAuth (inc 26) will extend.
>
> **THE load-bearing invariant:** `core` pulls in **native modules** (`better-sqlite3`, `@napi-rs/keyring`) that must NEVER reach the browser bundle. So: **route files and loaders MUST NOT import `@junction/core`.** All core access goes through a `createServerFn` in a `*.functions.ts`, which wraps a `*.server.ts` helper; **core is reachable only from `*.server.ts`.** This is the single most important rule of the increment, triple-guarded.
>
> **Builder:** Sonnet. Largest part is standing up a new framework + monorepo wiring.

---

## Part 1 — Spec (what & why)

### Goal
`junction web` builds-then-launches a localhost dashboard; you open `http://127.0.0.1:4321` and see your real platforms / credentials (metadata) / profiles+sources — read from `core`, no secrets, no mutations. Proof: `junction web` opens the browser to a working dashboard; the **client bundle contains no `better-sqlite3`/keyring/core**; credentials are metadata-only.

### Decisions baked in (the cross-cutting trio + framework)
- **TanStack Start v1** (`@tanstack/react-start` ^1.168, `@tanstack/react-router` ^1.170, React 19, Vite ^8, Nitro). v1 since Mar 2026; stable.
- **localhost-only, no auth.** Bind `127.0.0.1` (via `HOST` env to Nitro). The single local user already has full FS access to `JUNCTION_HOME` (the CLI reads the same DB) — the web adds **no new trust boundary**, just a second view. Networked mode (`0.0.0.0` + better-auth + AGPL §13 + token auth) stays **Tier-2 deferred**.
- **Management surface, not an agent API.** The browser talks to core via server functions (server-side). The **agent-facing API stays MCP** — we do not grow a second agent surface.
- **Callback-ready server.** OAuth's redirect (inc 26) will be one new server-route file on this same Nitro server — nothing extra to build now beyond keeping the structure.
- **`cli` ⊥ `web` (sibling apps, no code import).** `junction web` **spawns** the built web server as a subprocess and resolves it via `import.meta.resolve("@junction/web/server")` (a runtime call + an *artifact* package.json dep — NOT a source import edge). depcruise sees no edge; document the carve-out.

### The server-only core boundary (triple-guarded)
1. **Primary — `createServerFn`:** the Start Vite compiler strips the handler body from the client build (client gets a fetch stub), so anything the body imports (`core`) is excluded by construction.
2. **`*.server.ts` naming + Start import-protection:** server-only files are denied in the client environment → a leak **fails the build**, not ships.
3. **`vite.config.ts` `ssr.external`:** `["better-sqlite3", "@napi-rs/keyring", "@junction/core"]` — defense-in-depth.

Pattern (split pure/testable data from the RPC wrapper from the route):
- `src/server/data.server.ts` — imports core; plain async fns (`readDashboard`, `readPlatforms`, `readCredentials`, `readProfiles`) returning plain JSON. **Unit-testable.**
- `src/server/data.functions.ts` — `createServerFn({method:"GET"}).handler(...)` wrappers; the only thing routes import.
- `src/routes/*.tsx` — call the server fns in `loader`; never import core.

### Read-only data (mirror the CLI `--json` shapes exactly)
- **dashboard** → `{ platforms, credentials, profiles }` counts + status (`home`, `initialized`, credential-store label, sandbox label). Replicate the tiny label logic from `cli/commands/status.ts` in `*.server.ts` (do **not** import from cli — sibling apps).
- **platforms** → `repos.platforms.list()` → `{ id, kind, displayName, baseUrl? }[]`.
- **credentials** → `repos.credentials.list()` → **metadata ONLY: `{ id, platformId, account, kind }`. NEVER `secret`/`secretRef`.** (Mirror the mapping in `cli/commands/credential.ts`.) The most security-sensitive shape in the increment.
- **profiles** → `repos.profiles.list()`, sources joined to platform/credential metadata: `{ namespace, platform, credentialAccount, enabled, toolFilter? }` (`credentialAccount:"(none)"` for public sources). Never `secretRef`.

Views: `__root.tsx` (document + tiny nav) + four pages (dashboard cards, three tables). No forms, no mutating buttons.

### Robustness / safety
- **Host/Origin guard** (cheap, even read-only): accept requests only when `Host` is `127.0.0.1`/`localhost` — closes DNS-rebinding/CSRF against the loopback server.
- **No secret/secretRef** in any server-fn output, page, or — critically — the **client bundle** (the core-on-server boundary guarantees native deps stay server-side).
- **Read-only:** no POST server fns this increment.

### Proof of done
- `pnpm verify` green with web wired in (`tsr generate && tsc --noEmit` for web + the lib `tsc -b` + Biome + Vitest).
- **Client-bundle leak check (security-critical):** after `vite build`, the client output (`.output/public`) contains **no** `better-sqlite3`, `@napi-rs/keyring`, or core DB code (grep the built client assets; assert absent). This proves the boundary.
- Vitest: the `*.server.ts` data fns against a temp `JUNCTION_HOME` (seed via core repos) — assert correct shapes AND that the credentials JSON has **no `secret`/`secretRef` keys**.
- `pnpm build` (topological: core→…→web; web emits the Nitro server); `pnpm depcruise` 0 errors (no cli↔web edge; `@junction/web` path repointed); `pnpm quality` (0 clones). SPDX on every authored file; generated `routeTree.gen.ts` + `.output/`/`.nitro/`/`.tanstack/` gitignored.
- **MANUAL QA (orchestrator):** `pnpm build` then `junction web` → browser opens to `127.0.0.1:4321`; dashboard shows real counts; platforms/credentials(metadata)/profiles tables render from a seeded `JUNCTION_HOME`; confirm the server is **not** reachable on a LAN IP (bound to loopback); confirm no secret anywhere in the page or network responses.

### Out of scope (Tier-1 later / Tier-2)
All mutations → 23/24. Probe/call → 25. OAuth redirect route → 26 (structure leaves room). Auth + networked mode → Tier-2. Browser e2e (Playwright) → a later web increment. Tailwind / `react-doctor` → when UI grows (note Tailwind v4 as the path). Live config reload → Tier-2.

---

## Part 2 — Implementation

### Step 1 — `@junction/web` as a TanStack Start app
Rewrite `packages/web/package.json` as an **app**: deps `{@tanstack/react-start, @tanstack/react-router, react, react-dom, @junction/core: workspace:*}`; devDeps `{vite, @vitejs/plugin-react, nitro, babel-plugin-react-compiler, @tanstack/router-cli, @types/{react,react-dom,node}}`; scripts `{dev: "vite dev", build: "vite build", start: "node .output/server/index.mjs", typecheck: "tsr generate && tsc --noEmit"}`; `exports: {"./server": "./.output/server/index.mjs"}`; `license: AGPL-3.0-only`. **Confirm the emitted server path** at build time (Start prod output may be `.output/server/index.mjs` or `dist/server/index.js` depending on the pinned version) and align `start`/`exports`/the spawn to the actual path — record in `gotchas.md` if it differs.

`vite.config.ts` (SPDX): `server.host:"127.0.0.1"`, plugins `[tanstackStart({srcDirectory:"src"}), viteReact({babel:{plugins:[["babel-plugin-react-compiler",{target:"19"}]]}}), nitro()]` (this order), `ssr.external:["better-sqlite3","@napi-rs/keyring","@junction/core"]`. Rewrite `tsconfig.json` for an app: `jsx:"react-jsx"`, `moduleResolution:"bundler"`, `types:["node","vite/client"]`, drop `composite`/`references`, include `routeTree.gen.ts`. `.gitignore`: `.output/ .nitro/ .tanstack/ routeTree.gen.ts`. Delete the placeholder `src/index.ts` + stale `dist/`.

### Step 2 — routes + server boundary
- `src/router.tsx` (`getRouter()`), `src/routes/__root.tsx` (document shell + nav + the one `src/styles/app.css`), `src/routes/{index,platforms,credentials,profiles}.tsx` (each: `loader: () => getX()`, render a table/cards; **no core import**).
- `src/server/data.server.ts` (the four `read*` fns, import core, replicate status labels), `src/server/data.functions.ts` (four `createServerFn({method:"GET"})` wrappers). Split into per-domain files at the rule of three.
- The **Host/Origin guard**: smallest correct placement (a tiny check in a server middleware / the server fns / a Nitro route handler) rejecting non-`127.0.0.1`/`localhost` Host. Keep it minimal.

### Step 3 — `junction web` (cli spawns web)
`packages/cli/src/commands/web.ts` (SPDX): citty command; resolve `import.meta.resolve("@junction/web/server")` → `fileURLToPath`; `spawn(process.execPath, [entry], {stdio:"inherit", env:{...process.env, HOST:"127.0.0.1", PORT: args.port}})`; `--port` (default 4321), `--open` (default true) → a ~10-line `process.platform` browser opener (`open`/`xdg-open`/`cmd /c start`), no new dep; propagate exit code; clear message if the built server is missing ("run `pnpm build` first" / port busy). Register in `cli/src/index.ts`. Add `"@junction/web":"workspace:*"` to **cli `dependencies`** (artifact dep enabling `import.meta.resolve`; **not** a code edge). Document this carve-out in the method file + `gotchas.md`.

### Step 4 — monorepo wiring
- Root `tsconfig.json`: **remove** `{path:"packages/web"}` from references (a Vite app with a generated route tree doesn't belong in the `tsc -b` graph).
- Root `package.json` `verify`: add `pnpm --filter @junction/web typecheck` (so `tsr generate && tsc --noEmit` runs in the gate).
- `tsconfig.depcruise.json`: repoint `@junction/web` from the deleted `src/index.ts` to `src/router.tsx` (or drop — nothing imports web as code).
- **React Compiler** via the babel plugin (above). For hooks linting use **Biome's** `useExhaustiveDependencies`/`useHookAtTopLevel` (NOT `eslint-plugin-react-hooks` — ESLint-as-the-loop is banned). Record the eslint-plugin-react-hooks divergence + `react-doctor` deferral in `revisit-when.md`.
- Vitest needs **no config change** (root globs `*.test.tsx`, has the core src alias + `jsx:"automatic"`).

### Step 5 — tests + skill + futures
`src/server/data.server.test.ts` (temp `JUNCTION_HOME`, seed via core, assert shapes + **no secret/secretRef** in credentials). Update `junction-dev` skill (`junction web` / `pnpm --filter @junction/web dev`). `revisit-when.md`: Tailwind-when-UI-grows, react-doctor, eslint-plugin-react-hooks, browser-e2e. `gotchas.md`: the cli→web artifact-dep carve-out; the Start build-output-path confirmation; the server-only-core invariant.

### Step 6 — verify, build, commit
`pnpm verify` + `pnpm build` + the **client-bundle leak grep** + `pnpm depcruise` + `pnpm quality`. SPDX. Commit; push; PR base main.

---

## Review (background, after build)

- **`junction-package-boundary`** (lead): the **server-only core boundary** holds (no route/loader imports core; only `*.server.ts` does); the **cli→web spawn is not a code edge** (artifact dep + `import.meta.resolve`, documented); `web → core` only; no cli↔web import; depcruise 0 errors.
- **`junction-credential-security`**: credentials are metadata-only everywhere (server fn output, pages); **no secret/secretRef in the client bundle** (the leak grep) or any response; the Host/Origin guard is sound.
- **`ce-security-reviewer`**: localhost bind (not reachable off-host), DNS-rebinding/CSRF via the Host guard, no native deps in the client, no auth-bypass surface (there's no auth — confirm the trust model is honestly localhost-only).
- **`ce-correctness-reviewer`**: the loader→server-fn→`*.server.ts` data flow; the four data shapes mirror the CLI; `Result` handling from core repos; status labels replicated correctly.
- **`junction-clean-code-reviewer`**: thin server/route split; SPDX; single-purpose; the React-Compiler/Biome-hooks setup; no ESLint added; generated files gitignored.
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)
**Visually testable — YES:** `pnpm build && junction web` opens a localhost dashboard showing your platforms/credentials(metadata)/profiles. **QA'd by me:** ran it against a seeded `JUNCTION_HOME`; confirmed loopback-only bind, no secret in page/responses, and the **client bundle has no core/native deps** (grep). **Checklist:** TanStack Start app, server-only core via `createServerFn`/`*.server.ts` (triple-guarded), localhost-only + Host-guard, cli spawns web (artifact dep, no code edge), credentials metadata-only, read-only (no mutations), monorepo build/typecheck/depcruise/vitest wired, callback-ready for OAuth.

## User test gate
```bash
pnpm build
JUNCTION_HOME=/tmp/jt22 node packages/cli/dist/index.js init
# seed a couple platforms/profiles via the CLI, then:
JUNCTION_HOME=/tmp/jt22 node packages/cli/dist/index.js web        # opens http://127.0.0.1:4321
# verify: dashboard counts, platforms/credentials(metadata)/profiles tables; nothing secret; not reachable on your LAN IP
```
Approve → increment 23 (web management: platforms + credentials + rotation).
