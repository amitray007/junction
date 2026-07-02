---
increment: 27
title: junction-keys / single-endpoint MCP auth
depends_on: [26]
soft_after: []
touches: [core, mcp/server, cli, web, docs]
parallel_group: wave-27 # A (core, blocking) → B (mcp/server+cli) ∥ C (web) → D (docs, orchestrator)
---

# Increment 27 — junction-keys / single-endpoint MCP auth

> ⚠️ **This increment deliberately REVISES a load-bearing CLAUDE.md invariant** ("Per-profile
> MCP endpoints, not shared-endpoint filters") and ships junction's **first real HTTP MCP
> transport**. It is security-sensitive: real auth, real network listener, real keys.
> Correctness/security over speed applies everywhere below.
>
> Plan reviewed (security-lens + feasibility + spec-flow, 2026-07-02); all findings folded in.
> The biggest: the SDK's `allowedOrigins: []` is a **no-op** (verified in source), so Origin
> rejection is OUR handler's job — see §2.3.

## 0. What & why

junction mints its **own API keys** — scoped to one profile, several profiles, or global —
revocable, **hashed at rest**. A **single shared MCP endpoint** (`/mcp`, served by a new
long-running `junction serve` command) authenticates each request by key; **the key selects
which profile(s)** the consumer gets. This replaces the *conceptual* per-profile path
`/profiles/{name}/mcp`, which never existed as running code (serving today is stdio-only).

Why now: keys give **per-key identity**, which the audit increment (31) consumes for
attribution — so keys land before audit. Build before public release.

**Grounding facts (verified in recon + plan review):**

- There is **no HTTP MCP code anywhere** today. `junction mcp serve` is stdio-per-invocation
  (`packages/mcp/server/src/serve.ts` — `StdioServerTransport`; header comment explicitly
  defers HTTP). Inc 27 is "build the first HTTP transport with auth designed in", not
  "add auth to an endpoint".
- The MCP spec (2025-06-18) makes authorization **OPTIONAL**; a self-hosted server checking
  its own static Bearer keys is spec-compatible. No OAuth server / RFC 9728 / PKCE needed.
  Clients wire it as `"headers": {"Authorization": "Bearer <key>"}`.
- `@modelcontextprotocol/sdk` **1.29.0** (already our version) ships
  `StreamableHTTPServerTransport` (a Node wrapper over `WebStandardStreamableHTTPServerTransport`).
  **CVE-2025-66414 / GHSA-w48q-cv73-mx4w:** the SDK's DNS-rebinding protection is **OFF by
  default** (`?? false`, verified `webStandardStreamableHttp.js:70`); the attack (a browsed
  webpage POSTing to your localhost MCP server) is exactly our threat model. Enabling it —
  plus our own header guards (§2.3) — is **non-negotiable**.
- The credential store is reversible AES-256-GCM **encryption** (junction must replay those
  secrets upstream). API keys are junction's **own** secrets and need one-way **verification**
  only → **SHA-256 of a 256-bit random secret** (no brute-force surface → no KDF; no
  per-request KDF latency), compared with `crypto.timingSafeEqual`. Do NOT route keys
  through the credential store or scrypt.

**Trust boundary (stated so nobody assumes more):** the loopback bind + header guards defend
against browser/network-originated attacks (the CVE-2025-66414 class). They do **not** defend
against a co-resident malicious OS user on a shared multi-user host — out of scope for the
single-user threat model, accepted. Likewise, **no auth rate-limiting/lockout is added**
(deliberate): the secret space is 2^256 against a uniform 401, and a lockout on a loopback
single-user endpoint is a self-DoS lever, not a defense. Both notes go into the docs (slice D).

## 1. Decisions (locked with user, 2026-07-02)

| # | Decision | Call |
|---|---|---|
| 1 | Where the endpoint lives | **New long-running `junction serve`** CLI command backed by an HTTP listener in `mcp/server` (`serve-http.ts` sibling to stdio). The web server stays a loopback-only management UI. **stdio serving stays** (direct local wiring, process-trust, no key). |
| 2 | Network exposure | **Localhost-only.** Bind `127.0.0.1`, fail-closed Host/Origin guards + SDK DNS-rebinding protection. Networked mode (TLS, AGPL §13, better-auth) stays deferred with its existing revisit-when triggers. |
| 3 | Key format + hashing | **`jct_<keyid>_<secret>`** — keyid = the key's ULID (public, O(1) PK lookup, stable handle for revoke/audit/UI); secret = base64url(`randomBytes(32)`). At rest: **plain SHA-256 hex** of the secret; compare `timingSafeEqual`. **Display-once at mint**; lists show label + `jct_<keyid>` + created/lastUsed — never the secret. No HMAC pepper, no CRC32 tail (declined). |
| 4 | Multi-profile tool naming | **Arity-determined, fixed at mint:** single-profile key → `<namespace>__<tool>` (identical to stdio serving of that profile); multi-profile or global key → **`<profile>__<namespace>__<tool>`, always** (not collision-conditional). Collisions become impossible; names are stable per key; global keys grow gracefully as profiles are added. |
| 5 | Per-profile endpoint artifact | **Remove `mcpEndpointPath`** (schema field + superRefine + `deriveMcpEndpointPath` + DB column + all render sites). ONE `/mcp` path; the key does the selecting. |

**Sub-decisions (orchestrator calls, flagged — several added by the plan review):**

- **Scope kind is stored, not derived from live count:** `scope ∈ {'profile','profiles','global'}`
  recorded at mint. Naming arity derives from the stored kind — a `profiles` key that later
  loses profiles down to one **stays 3-segment**; a `global` key is 3-segment even when only
  one profile exists.
- **Scope counting dedupes first:** `--profile a --profile a` (and the web POST body — a trust
  boundary regardless of picker UI) resolves names → **dedupes by profile id** → the
  *distinct* count decides `profile` vs `profiles`. Duplicates collapse silently; a
  nonexistent profile name fails the whole mint (all-or-nothing, clear error, `--json` shape).
- **Global keys always authenticate.** `empty-scope` 401 applies ONLY to `profile`/`profiles`
  kinds whose join rows all cascaded away. A `global` key with zero profiles is a valid
  session with an empty tool list (it grows as profiles are created).
- **Profile deletion vs keys:** join rows `api_key_profiles` are **ON DELETE CASCADE**
  (scope can only *shrink* — fail-safe). The web delete-profile confirm warns when keys
  reference the profile ("N key(s) reference this profile and will lose it").
- **Uniform 401:** unknown / malformed / revoked / empty-scope keys all get the same
  401 body ("invalid or revoked API key"). Never echo or log the presented token.
- **Unknown/stale `mcp-session-id` → 404** (Streamable HTTP spec semantics — this is what
  lets clients auto-re-initialize after a serve restart). 401 is reserved for auth failures,
  including the fixation case (known session, different key — §2.3).
- **Revoke, then Delete.** Keys are otherwise immutable (no scope/label edit). `keys revoke`
  is **idempotent** (revoking a revoked key succeeds), takes a bare keyid **or** a full pasted
  token (parse via §2.1 regex, discard the secret), and unknown keyid → not-found error.
  **A REVOKED key may then be hard-deleted** (`keys delete` / the web ⋯ menu on revoked rows);
  the core `remove(id)` op **refuses an active key** (`in-use` → "revoke first"), so the
  active-key lifecycle stays auditable for inc 31 — a key is only ever removed *after* it was
  explicitly revoked. (Post-ship refinement: originally "no hard delete at all"; changed on
  user request to revoke-then-delete-revoked-only, which keeps the audit invariant intact.)
- **Labels:** one shared Zod schema in core (`api-keys/`): trimmed, non-empty, ≤64 chars;
  duplicates allowed (the keyid is the handle). CLI and web both consume it.
- **Default port 4322** (web is 4321 — adjacent, memorable). Precedence: `--port` flag >
  `config.mcpPort` > `JUNCTION_MCP_PORT` env (mirrors `getMcpHost` config>env, flag on top).
- **Live-reload parity:** keys are checked per-request against the DB → mint/revoke take
  effect immediately, no restart. Profile *content* AND the resolved profile *set* are
  snapshotted per session (proxies built once at `initialize`) — same convention as the
  existing live-config-reload deferral. A profile edit/creation applies to the *next*
  session; no `listChanged` notification is emitted. Builders must NOT re-resolve scope per
  `tools/list`.

## 2. Spec

### 2.1 Token format & crypto

```
jct_01JX3M8QK9RS2T5V7XZA0BCDEF_Vq2hT9cRk4wLmZnB7pYsD1fGx8uEaN5oHtKjMiC3vWb
└┬┘ └────────────┬────────────┘ └──────────────────┬─────────────────────┘
prefix   keyid = ApiKeyId ULID        secret = base64url(randomBytes(32))
         (26-char Crockford b32)      (43 chars, may contain - and _)
```

- Parse with `/^jct_([0-9A-HJKMNP-TV-Z]{26})_(.+)$/` — the keyid charset has no `_`, so the
  first two `_` delimit deterministically even though base64url secrets may contain `_`.
- Mint: `newApiKeyId()` (ids module — the single ULID swap point) + `crypto.randomBytes(32)`.
  Plaintext assembled once, returned once, never stored, never logged (mirror
  `add-credential.ts`'s "plaintext exists only in this stack frame" discipline). The CLI
  printing it once to stdout/TTY scrollback is accepted risk (inherent to any CLI mint flow).
- Verify: parse → PK lookup by keyid → `revoked_at IS NULL` → `timingSafeEqual(sha256(secret),
  stored_hash)` (both as Buffers; lengths always equal — fixed-size digests) → load scope.
  Unknown keyid short-circuits (keyid is public; timing on existence is acceptable).
- `last_used_at` updated on every successful auth — **best-effort/fire-and-forget: a failed
  or slow bookkeeping write must never fail or delay the auth decision** (the
  `removeCredential` reverse-orphan precedent in gotchas.md).

### 2.2 Data model (new tables + one removal)

```
api_keys
  id           TEXT PK        -- ApiKeyId ULID; doubles as the token's keyid segment
  label        TEXT NOT NULL  -- ApiKeyLabelSchema: trimmed, non-empty, ≤64; duplicates OK
  secret_hash  TEXT NOT NULL  -- hex sha256 of the secret segment; UNIQUE index
  scope        TEXT NOT NULL  -- 'profile' | 'profiles' | 'global'
  created_at   INTEGER NOT NULL
  last_used_at INTEGER        -- NULL until first use
  revoked_at   INTEGER        -- NULL = active; revoke = set timestamp (row retained for audit)

api_key_profiles              -- scope 'profile' → exactly 1 row; 'profiles' → ≥2; 'global' → 0
  api_key_id  TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE
  PRIMARY KEY (api_key_id, profile_id)

profiles.mcp_endpoint_path    -- REMOVED (SQLite table rebuild; see §5)
```

New branded `ApiKeyIdSchema` + `ApiKeyLabelSchema` in core + `newApiKeyId()` in `ids/index.ts`.
New `ApiKeyError` discriminated union in `errors/` (`invalid-format | unknown-key | revoked |
empty-scope | not-found | db-error`). All repo/ops return neverthrow `ResultAsync` — no bare
throws.

### 2.3 Endpoint behaviour (`/mcp`, Streamable HTTP)

- `node:http` server in `mcp/server` (`serve-http.ts`), bound `127.0.0.1:<port>`, single
  path `/mcp` (POST/GET/DELETE per Streamable HTTP; anything else 404). On `EADDRINUSE`:
  exit non-zero with an actionable message ("port 4322 in use — is another 'junction serve'
  running? use --port"). Running two serves on distinct ports against the same home is
  allowed (each is independent).
- **Our handler guards run FIRST, before the SDK transport sees any request (fail-closed,
  all mandatory):**
  1. **Host guard:** loopback Host literals only (`127.0.0.1[:port]`, `localhost[:port]`,
     `[::1][:port]`) — same posture as `serve.mjs`; anything else → 403.
  2. **Origin guard:** **any request bearing an `Origin` header → 403.** MCP clients send
     no Origin; only browser-originated requests do. ⚠️ This is OUR check because the SDK's
     is a footgun — **verified in SDK source** (`webStandardStreamableHttp.js:122`):
     `allowedOrigins: []` makes the Origin block a **no-op** (`length > 0` guard), and even
     a non-empty list passes Origin-less requests only / 403s listed-mismatches — there is
     no SDK way to express "reject anything browser-originated".
  3. **Body cap:** 1 MB request-body limit (the `serve.mjs` `MAX_BODY_BYTES` convention;
     the SDK does not enforce one). Over-cap → 413, connection ended.
  4. **Auth (every request):** parse Bearer → verify (§2.1) → uniform 401 on any failure.
- SDK transport config (defense-in-depth behind our guards):
  `sessionIdGenerator: () => randomUUID()`, `enableDnsRebindingProtection: true`,
  `allowedHosts: ["127.0.0.1:<port>", "localhost:<port>"]`. (No `allowedOrigins` — our
  Origin guard owns that.)
- **Auth on EVERY request** (the spec requires the Bearer header on every request anyway).
  Revocation is therefore immediate — no propagation window, no trusting `mcp-session-id`
  for auth: a revoked key's very next request (and every request) fails 401, so a session
  cannot outlive its key's revocation. (Eager proactive teardown of a revoked key's live
  sessions is NOT built — the per-request re-check is the actual, stronger guarantee; an
  idle session holds no privilege because it re-authenticates on use. Session count is
  capped + the map is bounded so a valid-key holder can't exhaust memory by looping
  `initialize`.)
- **Session ↔ key binding (precise semantics — two mechanisms, don't conflate):** a session's
  handlers/proxies/scope are **frozen at `initialize` under the minting key** (keys are
  immutable, so the frozen scope can never be stale — only the key's *revoked* bit changes,
  which the per-request auth catches). Every subsequent request must (a) present a currently
  valid key AND (b) present **the same key that minted the session** — a different key, even
  a valid one, → 401 (fixation/scope-confusion guard). Unknown session-id → 404 (§1). The
  request-dispatch path must route through BOTH checks before touching the session's cached
  handlers — never auth-then-dispatch-by-session-id-alone.
- Tool serving: at `initialize`, resolve the key's scope → load profile(s) → build the proxy
  (§2.4) → `createMcpServer` handlers, composition mirroring the stdio path
  (`cli/commands/mcp.ts`). **Failure boundary:** a scope profile whose *row* is missing is
  simply absent (cascade already removed the join row; a transient race reads as absent —
  fail-safe shrink); a profile that loads but whose *source* fails to resolve **degrades
  per-source exactly like stdio** (skip + stderr note) — one broken credential must not
  brick a global key.
- **Error sanitization is endpoint-wide, not auth-only:** every `/mcp` error response —
  malformed JSON-RPC, DB failure, transport error — is generic/sanitized (no exception text,
  no stack, no SQL, no paths), reusing `safeUpstreamMessage` discipline. **Neither platform
  credentials nor junction keys ever appear in any response, log line, or error.**

### 2.4 Naming & the multi-profile proxy (core)

- New core composition `createScopedProxy(entries: Array<{profileName, proxy: ProfileProxy}>,
  prefixed: boolean)` in `sources/` (sibling to `proxy.ts`):
  - `prefixed: false` (scope kind `profile`): passthrough to the single profile's proxy —
    byte-identical tool names to stdio serving of that profile.
  - `prefixed: true` (`profiles`/`global`): `listTools` = concat of per-profile lists with
    `<profileName>__` prepended; `callTool` splits on the FIRST `__` → profile → delegates
    the remainder to that profile's proxy (which splits namespace/tool as today).
- **Charset contracts are now load-bearing for parsing** (record in code comments + docs):
  profile names `^[a-z0-9-]+$` (**no underscores, ever**) and namespaces
  `[a-z0-9]+(_[a-z0-9]+)*` (**never `__`**) are what make first-`__` splitting
  deterministic. Loosening either schema later breaks the naming contract — the schemas
  get a comment saying so + a regression test asserting the charsets reject `_`/`__`.
- **≤64 length guard extends, not duplicates:** the existing central guard
  (`sources/naming.ts`, enforced in `createProfileProxy` for list AND call) applies to the
  FINAL assembled name. The prefixing layer re-applies the same check after prepending
  `<profileName>__` — an over-long prefixed name is skipped consistently in list and call
  (existing convention). The web mint dialog + `keys create` warn when a selected scope
  would skip tools (a static worst-case check against namespace lengths is enough — no dry
  `listTools` required; keep it cheap and honest).

### 2.5 CLI surface (all headless-scriptable)

```
junction serve [--port <n>]          # long-running HTTP MCP endpoint (127.0.0.1)
junction keys create --label <s> (--profile <name>... | --global) [--json]
                                     # prints the full key ONCE (plus a stderr warning that
                                     # it will not be shown again); --json → {key, keyid, ...}
junction keys list [--json]          # label, jct_<keyid>, scope, created, lastUsed, status
junction keys revoke <keyid-or-full-token> [--json]   # idempotent; full token → keyid parsed
```

`serve` logs to stdout freely (it is NOT the stdio MCP channel — that constraint stays
stdio-only). `keys create`: `--global` and `--profile` are mutually exclusive (citty-
conventional error + non-zero exit + `--json` error shape); names resolved → deduped by id →
distinct count decides scope kind (§1); any unknown name fails the whole mint. Label
validated by the shared core schema.

### 2.6 Web surface (reuse inc-26 chrome)

- New `/keys` route + sidebar entry (manage group: Platforms · Profiles · Credentials · Keys).
- Table via `useTableView` (search/sort/pagination) + `FacetSelect` (scope, status).
  Columns: label · `jct_<keyid>` (mono) · scope badges (profile names / "global") ·
  created · lastUsed · status (active/revoked). ⋯ menu → Revoke (ConfirmDialog; hidden/
  disabled on already-revoked rows; a revoked row shows **Delete** instead — §1). Empty state per the
  `credentials.tsx` pattern with a mint CTA.
- **Mint dialog:** label + scope selector (global toggle | profile multi-picker). On success
  shows the full key ONCE with a copy button + "you won't see this again — if you miss it,
  revoke this key and mint a new one" note; if scope resolves to ≥2 profiles or global, note
  the `<profile>__` tool-name prefixing so the user isn't surprised. With **zero profiles**
  existing, the multi-picker is empty and Global is the only enabled scope (with a "create a
  profile to scope more narrowly" hint) — a global key is still mintable.
- Server-fn pattern per inc-24/26: `keys-mutations.functions.ts` (POST createServerFn, pure
  validator — dedupes the profile-id list, a trust boundary) → `assertLocalHost()` →
  `keys-mutations.server.ts` → core. **Metadata-only returns, with exactly one exception:
  the mint response carries the plaintext key once** (never re-fetchable; `secret_hash`
  never returned anywhere). `router.invalidate()` + toast.
- **AgentConfig goes live — but honestly bounded to loopback.** The "Shared endpoint"
  ComingSoon + HonestyNote flip to the real model. **Endpoint display is ALWAYS
  `http://127.0.0.1:<getMcpPort()>/mcp`** (config `mcpPort` > env > 4322), regardless of
  `mcpHost`. ⚠️ **Do NOT derive the endpoint from `mcpHost`** — a non-loopback `mcpHost`
  (the Settings page accepts one today, and old AgentConfig rendered it) would produce a
  copy-paste config that the loopback Host guard 403s / the bind refuses. If `mcpHost` is set
  and non-loopback, render an honest note ("networked HTTP serving is deferred — the endpoint
  is localhost-only in this version"), not a broken URL. Config snippets carry a real
  `Bearer <paste-your-key>` placeholder + a link to `/keys`, plus an honest "requires
  `junction serve` running" line (the dashboard cannot know the server is up — do NOT fake
  liveness; probing is inc 28). The "Today (stdio)" tab stays as the alternative.
- Delete-profile confirm dialog (`routes/profiles.tsx` ConfirmDialog) gains a "N key(s)
  reference this profile and will lose it" warning when keys reference the profile.

## 3. Security invariants (hold or stop)

1. Key plaintext exists only: (a) in the mint stack frame + its single response, (b) in the
   client's Authorization header per request. Never persisted, never logged, never in an
   error, never in `keys list`, never in any web response after mint. (CLI stdout/TTY at mint
   is accepted risk — §2.1.)
2. Hashed at rest (SHA-256 hex), compared constant-time. No KDF, no encryption-store reuse.
3. Auth re-validated on every HTTP request; sessions frozen to their minting key; revocation
   immediate (+ best-effort live-session teardown).
4. Our own Host guard + Origin guard (any Origin header → 403) + body cap run BEFORE the SDK
   transport; SDK DNS-rebinding protection ON with explicit `allowedHosts` as defense-in-depth.
   The Origin guard is ours because the SDK's `allowedOrigins` cannot express "reject
   browser-originated" (verified in source — §2.3).
5. Platform credentials keep ALL existing discipline (fetched per-call, never in output);
   the HTTP path adds no new credential surface.
6. Fail closed everywhere: parse failure, DB error, empty `profile`-scope, unknown session
   → 401/403/404 as specified, never a degraded-but-open endpoint. Endpoint-wide error
   sanitization (no exception text/stack/SQL/paths in any `/mcp` response).
7. Web: server-only core boundary unchanged; leakcheck must stay green; mint response is
   the sole plaintext carrier.
8. **Trust boundary stated explicitly:** localhost bind defends against browser/network
   (CVE-2025-66414 class) and other-local-*process* reach (a process still needs a valid
   key). It does NOT defend against a co-resident malicious OS *user* on a shared multi-user
   host — out of scope for the single-user threat model (record in §0/futures).
9. **No auth-attempt rate-limiting in inc 27, by decision:** loopback-only + a 256-bit random
   secret per known keyid makes network guessing infeasible, and there is no low-entropy
   surface. Recorded as an accepted, explicit posture (not silence) — revisit if/when
   networked mode lands (its own increment brings TLS + a broader threat model).

## 4. Wave plan (mode A) + builder briefs

Inc-26 lessons applied: **commit-to-lock A before fanning out; one file = one writer;
B and C touch disjoint packages; query agent status before assuming a stall; take direct
control sooner if coordination breaks.**

### Slice A — core (blocking; ONE Sonnet builder; lands + commits first)

*touches: core + the mechanical `mcpEndpointPath` removal sweep across the repo (serialized
here precisely so B/C never touch those files). The sweep includes ONE mcp/server test file
— see the explicit list below; this is the sole sanctioned A-touch outside core, and it does
not collide with B's new files.*

**Read first:** this file §1–3; `docs/rules/` (TS, testing, security); `schema/primitives.ts`,
`schema/profile.ts`, `ids/index.ts`, `errors/index.ts`, `repositories/{index,profiles,credentials}.ts`,
`credentials/add-credential.ts` (mint discipline), `sources/{proxy,naming}.ts`,
`config/index.ts` (mcpHost pattern), `db/schema.ts` + `db/migrations/meta/_journal.json`,
gotchas: migration journal monotonicity + drizzle-kit generate recipe + stale tsbuildinfo.

**Build:**
1. `ApiKeyIdSchema` (branded) + `ApiKeyLabelSchema` (trim/1–64/non-empty) in `schema/`;
   `newApiKeyId()` in `ids/`; `ApiKeyError` union in `errors/`.
2. `db/schema.ts`: `api_keys` + `api_key_profiles` per §2.2; **remove `mcpEndpointPath`
   column**. Migration via **`drizzle-kit generate`** (the gotchas recipe — temp config +
   `packages/core` local node_modules; NEVER hand-author; journal `when` must stay monotonic
   and exceed the poisoned `1782600000000` high-water — a fresh generate does; confirm the
   snapshot lands in `meta/`). Verify the `cpSync` build step carries the new migration into
   `dist/migrations`.
3. `repositories/api-keys.ts`: `create` (key row + join rows in ONE transaction; caller
   passes an already-deduped distinct profile-id set), `list`, `revoke(id)` (idempotent),
   `touchLastUsed(id)` (best-effort), `getByKeyId(id)` (+ scope profile-ids). Wire into
   `createRepositories` + exports.
4. `api-keys/` core module: `mintApiKey({label, scope, profileIds}) → {plaintext, meta}`
   (§2.1 discipline; assemble/return plaintext once), `verifyApiKey(token) →
   ResultAsync<ResolvedKey, ApiKeyError>` where `ResolvedKey = {keyId, label, scope,
   profileIds}` — parse/lookup/timingSafeEqual/revoked/empty-scope per §2.1+§3, `sha256Hex()`
   local. **`empty-scope` only for `profile`/`profiles` kinds with 0 rows; `global` with 0
   rows resolves OK to an empty profileIds set.**
5. `sources/scoped-proxy.ts`: `createScopedProxy` per §2.4 incl. the re-applied ≤64 guard.
6. **`mcpEndpointPath` removal sweep — the FULL grep-verified list** (pure removal, no
   behavioural replacement):
   - core: `schema/profile.ts` (field + superRefine), `schema/primitives.ts`
     (`deriveMcpEndpointPath`), `schema/index.ts` + `index.ts` (barrel re-exports),
     `repositories/profiles.ts` (reconstruction), `schema/schema.test.ts`,
     `repositories/repositories.test.ts`.
   - **`mcp/server/src/server.test.ts`** (imports `deriveMcpEndpointPath` + sets the field in
     a fixture — **A MUST edit this or `tsc -b` fails; this is the one sanctioned A-touch in
     mcp/server**, and B's new HTTP tests are separate files so one-file-one-writer holds).
   - cli: `tui/data.ts`, `tui/ProfilesPanel.tsx` (renders the field), `tui/dashboard.test.tsx`,
     `commands/profile.ts`, `commands/mcp.ts` (+ command tests).
   - web: `server/data.server.ts`, `server/profile-mutations.server.ts`,
     `routes/-profiles.test.tsx` (typed fixtures).
7. `config`: optional `mcpPort` (number, 1–65535, validated at the write boundary like
   `isValidMcpHost`) + `getMcpPort` (config > env `JUNCTION_MCP_PORT` > **4322** default) +
   `setMcpPort` (mirror `setMcpHost` incl. the destructure-clear pattern).
8. Charset-contract comments + regression tests on `ProfileNameSchema` (rejects `_`) and
   `ToolNamespaceSchema` (rejects `__`), stating the naming-parse dependency.

**Tests (Vitest, alongside code):** mint/verify round-trip; wrong secret → fail; revoked;
empty-scope (profile-kind, 0 rows) vs global-0-rows-OK; adversarial token parses (empty, no
prefix, bad keyid charset, embedded `\n`, unicode, 10 KB token, full-token-into-revoke);
hash is hex-sha256 of secret only; timingSafeEqual (equal-length buffers); scoped-proxy
2-seg vs 3-seg list/call, first-`__` split with hyphenated profile names, ≤64 skip
consistency list vs call; repo CRUD + cascade (delete profile → join row gone; key row
stays); idempotent revoke; label schema bounds; **staged cross-version migration test**
(inc-16 `0004` pattern — apply prior migrations on a raw DB, seed profiles WITH
`mcp_endpoint_path` + a full source_refs row, apply the new migration, assert rows survive,
column gone, `api_keys`/`api_key_profiles` present); config mcpPort precedence + validation.

**Do NOT:** touch mcp/server *except* `server.test.ts` (item 6); touch cli/web beyond the
listed sweep sites; add a `default` to any exhaustive switch (stale-tsbuildinfo myth —
`pnpm build` instead); use `fs.*Sync` in core; log or return plaintext anywhere but mint's
return value.

**Report back:** files changed, migration filename + journal `when`, `pnpm verify` output,
test-count delta, any deviation.

→ **Orchestrator: review, `pnpm verify`, drive a staged-migration check on a real copied DB,
COMMIT (lock), then fan out B ∥ C.**

### Slice B — backend leaf (ONE Sonnet builder): mcp/server HTTP + cli serve/keys

*touches: mcp/server (new `serve-http.ts` + a one-line relax to `server.ts`), cli (new
`commands/serve.ts` + `commands/keys.ts` + `index.ts` registration). Disjoint from A's sweep
(`commands/mcp.ts` is A-only; B's cli files are new; `server.test.ts` is A-only, B's HTTP
tests are new files).*

**Read first:** §2.3/2.5/§3; `mcp/server/src/{serve,server}.ts`; `cli/src/commands/{mcp,web}.ts`
(composition-root + spawn/EADDRINUSE-gap patterns); SDK `webStandardStreamableHttp.js`
(the guards we replace/supplement); gotchas: MCP stdout discipline, INTEGRATION_FILES.

**Build:**
1. `mcp/server/src/serve-http.ts`: `serveHttp(opts)` per §2.3 — our Host/Origin/body-cap/auth
   guards run first, THEN the SDK transport. Injection boundary preserved: it receives
   callbacks (`authenticate(token) → ResultAsync<AuthedKey, ApiKeyError>`,
   `buildHandlers(AuthedKey) → McpServerHandlers`) and never imports repos/store itself
   (mcp/server = SDK + core types only). Session map (sessionId → {transport, server, keyId,
   frozen scope}); teardown on DELETE/close/revoke; the same-key-required + unknown-session-404
   checks per §2.3.
2. **`server.ts`: make `createMcpServer`'s `profile` param optional** (it is currently
   `void profile` / vestigial, server.ts:115) so a multi-profile/global session needs no
   single Profile. Existing stdio call sites (`serveStdio` in `commands/mcp.ts`) pass it
   unchanged — no behaviour change.
3. `cli/src/commands/serve.ts`: composition root mirroring `mcp.ts` — paths/DB/store/
   resolveProvider, `verifyApiKey` as the authenticate callback (re-resolved EVERY request),
   scope → profiles → per-profile `createProfileProxy` → `createScopedProxy` → handlers. Port
   per §1 precedence. EADDRINUSE → actionable non-zero exit. Graceful SIGINT shutdown (close
   sessions + server).
4. `cli/src/commands/keys.ts`: create/list/revoke per §2.5, `--json` paths, key printed once
   to stdout (human path adds the stderr "shown once" warning); revoke accepts bare keyid or
   full token; mutually-exclusive scope flags.
5. Register `serve` + `keys` in `cli/src/index.ts`.

**Tests (HTTP integration on an ephemeral port, real `fetch`/SDK client; add every spawning
suite to `INTEGRATION_FILES`):** initialize+list with a valid key (2-seg AND 3-seg scopes);
no/bad/revoked key → uniform 401; revoke mid-session → next request 401; known session +
different valid key → 401; **unknown/stale session-id → 404**; request with `Origin` header
→ 403; non-loopback `Host` → 403; over-cap body → 413; **global key with one broken source
still initializes and serves the rest**; global key with zero profiles → valid empty session;
EADDRINUSE exit path; a log-capture test asserting the token never appears in serve logs.

**Do NOT:** write to stdout in any stdio-serve path; log tokens; import DB/store inside
mcp/server; touch files A swept (beyond the `server.ts` param relax, which is B's).

### Slice C — web leaf (ONE Sonnet builder): /keys UI + AgentConfig live

*touches: web only (new `keys-mutations.{functions,server}.ts` + `routes/keys.tsx` + sidebar +
`ui/agent-config.tsx` + the profile-delete dialog warning + route tree). Disjoint from A's
web-sweep sites and from B entirely.* Per §2.6.

**Read first:** §2.6/§3; `routes/credentials.tsx` (canonical CRUD table), `routes/profiles.tsx`
(ConfirmDialog), `server/{mutations,shared}.server.ts` + `fn-guards.server.ts` patterns,
`ui/{agent-config,coming-soon}.tsx`, `lib/use-table-view.ts`, `ui/facet-select.tsx`,
`docs/rules/web.md`, DESIGN.md.

**Tests:** mint dialog display-once (key visible after mint, absent after close/reopen, absent
from list + loader); revoke flow + revoked-row disabled action; scope facet; zero-profiles
mint dialog (global-only); loader returns metadata-only (JSON-stringify negative test for
`secret_hash`/plaintext); AgentConfig renders the **127.0.0.1** endpoint + Bearer snippet +
"requires junction serve" note + NO ComingSoon, and the non-loopback-`mcpHost` honest-note
branch; delete-profile warning when keys reference it. `verify:web` + leakcheck + css-tokens
green; drive the built artifact (junction-web-verify) at QA.

### Slice D — docs (orchestrator, after B+C integrate)

CLAUDE.md invariant rewrite (naming: 2-seg base + 3-seg multi-profile extension; endpoint:
single keyed `/mcp` supersedes per-profile paths), foundation design spec update,
`docs/futures/`: strike the "MCP-endpoint auth via junction keys" revisit-when row (resolved
inc 27); update "Streamable HTTP transport" (localhost HTTP now exists; *networked* serving
still deferred) + "long-running daemon" (exists as `junction serve`; core stays daemon-free);
AGPL §13 row unchanged (trigger = network users — still dormant); NEW revisit-when: the
**profile-rename hazard** (rename doesn't exist today; if it ships, multi-profile keys'
3-seg tool names embed the live profile name → drift; options: pin names at mint vs forbid
rename on key-referenced profiles) + the unbounded session-map idle-timeout note. NEW
gotchas: the DNS-rebinding CVE + our-guards-not-SDK-Origin config; charset contracts
load-bearing for naming; `allowedOrigins:[]` SDK no-op. STATE.md via `junction-handover`
(marker → 27).

**Integration:** A commits first (lock) → B ∥ C build in parallel → apply serially (B then
C), **`pnpm verify` after each** → then the real-artifact drive (§6).

## 5. Migration notes (the risky bit)

- One generated migration (expected `0007_*`): create `api_keys` + `api_key_profiles`, drop
  `profiles.mcp_endpoint_path`. The drop is a **SQLite table rebuild**
  (create-new/INSERT…SELECT/drop/rename — the inc-16 `0004` shape). Generated via drizzle-kit
  ONLY (the gotchas recipe), never hand-authored.
- Journal `when` must exceed the poisoned high-water `1782600000000` (0003's inflated value —
  the actual constraint, larger than 0006). A fresh generate today (~`1782950400000`) clears
  it; re-check monotonicity anyway. Pre-27 dev DBs from the inc-15–20 window are already
  documented-broken (recreate them) — unchanged by us.
- The staged cross-version preservation test (§4-A) is mandatory — a rebuild that drops rows
  would destroy every profile.

## 6. Proof-of-done (orchestrator QA — independent, against the real artifact)

1. `pnpm verify` green after each slice; CI green (Node 20 + 22, depcruise, dup, web-build,
   gitleaks).
2. **End-to-end against real built code** (ephemeral `/tmp/jt27` home, seeded: ≥2 profiles,
   one shared-namespace pair to prove 3-seg naming, real platform + credential): `junction
   serve` → real MCP client (`StreamableHTTPClientTransport`) with a minted key → `tools/list`
   shows the correct arity-named set → `tools/call` executes through a real source → revoke →
   next request 401 → re-mint → works.
3. **Adversarial pass:** no key / garbage / truncated / other key's session-id → 401;
   unknown session-id → 404; `Origin: https://evil.example` → 403; `Host: evil` → 403;
   over-cap body → 413; grep serve logs + `ps` argv + the DB file + `/tmp/jt27` for the
   plaintext key → zero hits outside the mint moment; stdio serve still works unchanged;
   single-profile key names == stdio names for the same profile (byte-identical list).
4. Web driven via `junction-web-verify`: mint (key shown once), list, revoke, AgentConfig
   real config copy-pasted into a real client config actually connects; non-loopback-mcpHost
   shows the honest note, not a broken URL.
5. Staged-migration proof on a copy of a real pre-27 home.

## 7. Reviewers (step 6)

Always: `junction-package-boundary`, `junction-clean-code-reviewer`. This increment:
**`junction-mcp-contract`** (now active — first HTTP transport), **`junction-credential-security`**
(key handling), `ce-security-reviewer` (auth middleware — auto-selected), `ce-correctness-reviewer`,
`ce-testing-reviewer`, **`ce-data-migration-reviewer`** (the column-drop rebuild),
`junction-web-reviewer` (slice C).

## 8. User test gate (step 7) — visually testable: YES

```bash
pnpm build
# seed a couple of profiles first (or use an existing home); then:
JUNCTION_HOME=/tmp/jt27 node packages/cli/dist/index.js keys create --label demo --global
JUNCTION_HOME=/tmp/jt27 node packages/cli/dist/index.js serve            # leave running
# → paste the printed key into Claude Code / Cursor MCP config:
#   { "type": "http", "url": "http://127.0.0.1:4322/mcp",
#     "headers": { "Authorization": "Bearer jct_..." } }
# → agent lists/calls tools; then:
JUNCTION_HOME=/tmp/jt27 node packages/cli/dist/index.js keys revoke <keyid>
# → agent's next call fails with 401. Web: junction web → /keys (mint/revoke) + dashboard
#   AgentConfig now shows the live localhost model.
```