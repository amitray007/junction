# Increment 24 — Web: credentials management + rotation (first web write-path)

> **Builder: read first, in order.** `docs/STATE.md` (current state), `CLAUDE.md`
> (architecture + behaviours), `docs/behaviours/verify-the-artifact.md` (a green gate ≠ a
> working product — you MUST drive the real built artifact), `docs/rules/` (typescript,
> testing, security, **web.md** incl. the anti-AI-slop checklist), `docs/design/DESIGN.md`
> (tokens — never invent design values), `docs/futures/gotchas.md` (esp. the TanStack SSR
> request-data + `pnpm verify` web notes). Then this file. Self-contained.

## 1. What & why

The first **web write-path.** Today the web dashboard is read-only; the CLI is the only way
to add/remove credentials and there is no rotation anywhere. This increment adds:

1. **Core: `rotateCredential`** — swap a credential's secret in place (new secret → store →
   atomically repoint `secretRef` → delete old), keeping the same credential id/account/platform.
2. **CLI: `credential rotate`** — the headless/scriptable path (every interactive command keeps
   a `--json` path; mirrors `credential add`).
3. **Web: credentials management UI** — add / delete / **rotate** a credential from the browser,
   wired through `createServerFn` mutations, **assembling on the inc-23 primitives** (form
   primitives `input/field/select/switch`, `PageHeader`, table actions-column scaffold, `<Toaster/>`,
   `router.invalidate()`). This is *assembly, not scaffolding* — the chassis exists.

**Why credentials first** (of the web mutation increments 24–27): the core credential ops
(`addCredential`/`removeCredential`) already exist and are clean, so the web write-path lands with
minimal new core surface — only `rotateCredential`. Platforms (25) needs a `cli→core` extraction
first; profiles (26) is more complex. Credentials is the cleanest first write-path to prove the
pattern (mutation server-fn + form + optimistic-ish feedback + invalidate) that 25–27 reuse.

### Non-goals
- No OAuth / `arctic` (inc 28). Rotation here is for **manually-supplied secrets** (api-key/bearer/etc.).
- No platform or profile mutations (25/26). No probe/call (27).
- No master-key rotation (that's inc 30 — different thing; this rotates ONE credential's secret).
- No live status-rail pulse / "Connected" liveness (needs probing, inc 28) — badges stay **Configured**.

## 2. Hard invariants (load-bearing)

1. **Secret never leaves the process / never in a return value, error, or log.** `rotateCredential`
   follows `addCredential`'s discipline exactly (secret only in memory during the call; only the
   `secretRef` is persisted; return type carries metadata only). The web mutation accepts the new
   secret over the **localhost-only** POST and passes it straight to core — it is NEVER echoed back,
   never put in the loader data, never rendered. (Re-read `add-credential.ts` for the pattern.)
2. **Rotation is atomic / fail-safe.** Write the new secret to the store FIRST, then repoint the DB
   row's `secretRef`, then delete the OLD store entry. On DB failure after the new write: clean up the
   new store entry and leave the old `secretRef` intact (credential still works with the old secret).
   Never leave the credential pointing at a missing/half-written secret. Return a typed `Result`.
3. **Server-only-core boundary preserved** (inc-22/23): mutation server-fns live in `src/server/`
   (import core there only); routes call them via the `createServerFn` RPC. No `@junction/core` in any
   client-reachable module. The `web:leakcheck` + `web:smoke` gates must stay green.
4. **localhost-only + input validation at the boundary.** Every mutation server-fn calls
   `assertLocalHost()` (as the GET fns do) AND Zod-validates its input before touching core. A
   mutation is a POST `createServerFn` — confirm it's still localhost-guarded.
5. **a11y + anti-slop** (web.md): forms use the `field` primitive with real label association +
   inline error (aria-describedby on the control — **fix the inc-23 `field.tsx` bug first**, see §3),
   visible amber focus, no color-only state, reduced-motion-safe, lucide icons (no emoji), tokens only.
6. **Every change ships QA-able** (`docs/behaviours/verify-the-artifact.md`): `pnpm verify` green
   (now includes `verify:web` — build + smoke), plus a `junction-web-verify` browser pass on the new
   forms, plus core/CLI tests incl. the **secret-never-leaks negative test** for rotate.

## 3. Prerequisite fix (do first — owed from inc 23)

`packages/web/src/ui/field.tsx`: `aria-describedby` is currently on a wrapper `<div>`, so it never
associates with the control — screen readers won't announce the error/description. **Fix before
wiring any form:** the field owns the id and must apply `aria-describedby` (+ `aria-invalid`) to the
**control element** (clone/pass onto the child, or have callers spread it). Add a test asserting the
control carries the describedby id. (Flagged by the inc-23 web review.)

## 4. Implementation

### Phase A — core `rotateCredential`
- `packages/core/src/credentials/rotate-credential.ts`: `rotateCredential(input: { credentialId; newSecret }, store, credentialsRepo): ResultAsync<Credential, CredentialError | DbError>`. Look up the row → write `newSecret` to the store under a fresh `secretRef` → update the row's `secretRef` → delete the old store entry. Atomic/fail-safe per invariant #2. Export from `credentials/index.ts`.
- Tests (`rotate-credential.test.ts`, temp `JUNCTION_HOME`): happy path (secret changes, id/account stable); **negative: `newSecret` never appears in the return value or error**; DB-failure-after-store-write rolls back cleanly (old secret still resolves); unknown credentialId → typed error.

### Phase B — CLI `credential rotate`
- `packages/cli/src/commands/credential/rotate.ts` (mirror `add.ts`): `credential rotate --id <id> --secret-stdin [--json]`. Reads the new secret from stdin (never argv — same as add's `--token-stdin`). Calls `rotateCredential`. `--json` path for agents. Wire into the `credential` command group.
- Test: rotate a seeded credential, assert success + that the stored secret changed (and the secret is not in stdout/json).

### Phase C — web mutations (server-fns)
- `packages/web/src/server/mutations.functions.ts` (or extend `data.functions.ts`): `addCredentialFn`, `removeCredentialFn`, `rotateCredentialFn` as **POST** `createServerFn`s, each `assertLocalHost()` + Zod-validate input, then call the core op. Return metadata-only result (or a typed error shape the UI maps to a toast). The new secret is an input only — never returned.
- Reuse the existing `data.server.ts` core wiring (repos/store construction) — don't duplicate it.

### Phase D — web UI
- Re-skin `routes/credentials.tsx` from read-only → managed: a **PageHeader** primary action "Add credential" opens a **dialog** with a `field`+`input`/`select` form (platform select, account input, kind select, secret input — secret field `type=password`, never pre-filled, never read back); each table row gets the **actions column** (the inc-23 scaffold) → a `⋯` menu with **Rotate** (dialog: new secret) and **Delete** (confirm dialog).
- On submit: call the mutation fn → on success `await router.invalidate()` (refresh the list — the inc-23 `staleTime` makes navigation cached but invalidate forces fresh) + a **sonner** toast ("Credential added/rotated/deleted"); on error, an inline field error or an error toast. Optimistic-ish feedback is fine but the invalidate is the source of truth.
- Keep the empty-state + the CLI hint. Badges stay **Configured** (no liveness yet).

### Phase E — tests + QA
- Route/component tests (happy-dom + TL): the add form validates + calls the mutation (mock the server-fn); the rotate/delete row actions render + are keyboard-reachable; field error announces (the §3 fix). 
- `junction-web-verify` browser pass: add → row appears; rotate → toast, no secret visible anywhere; delete → row gone; forms keyboard-navigable with amber focus; light+dark; reduced-motion.

## 5. Proof-of-done
- [ ] `pnpm verify` green (incl. `verify:web`: build + leakcheck + **smoke** + web tests) on Node 20 + 22; `pnpm depcruise` clean.
- [ ] Core `rotateCredential` + its tests incl. the **secret-never-leaks** negative test; rotation is atomic/fail-safe (tested).
- [ ] CLI `credential rotate` with a `--json`/stdin path + test; secret never in argv/output.
- [ ] Web: add / rotate / delete work end-to-end against the **real built server** (verified via `junction-web-verify`, not just unit tests) — toast feedback, list refreshes via `router.invalidate()`, **no secret in any response/HTML** (the `web:smoke` secret-leak assertion still passes + a manual check of the rotate/add responses).
- [ ] The inc-23 `field.tsx` `aria-describedby` fix landed + tested.
- [ ] No `@junction/core` in client modules; mutations are localhost-guarded + Zod-validated; tokens-only; anti-slop clean.

## 6. Reviewers (step 6 gate)
`junction-credential-security` (the secret-handling path — this is its increment; rotate atomicity + no-leak), `junction-web-reviewer` (the new forms/mutations + a11y + anti-slop), `junction-package-boundary` (boundary holds with the new server-fns), `ce-correctness` (rotation atomicity/rollback + the mutation→invalidate flow), `ce-security` (the localhost POST mutation surface + secret-in-transit), `ce-testing` (the negative tests). Run `junction-web-verify` + a browser dogfood. (Skip TUI/sandbox/mcp reviewers — not touched.)

## 7. User test gate
Visually testable: **yes** (first web write-path). After build+seed (`/tmp/jt24`):
`JUNCTION_HOME=/tmp/jt24 PORT=4321 node packages/web/serve.mjs` → add a credential in-browser,
rotate it, delete it; confirm toasts, the list updates, and (via CLI `credential list` / the store)
the secret actually changed on rotate. Plus `credential rotate --id … --secret-stdin --json`.

## 8. Notes
- This increment proves the **mutation pattern** (POST server-fn + form primitive + `router.invalidate()`
  + toast) that platforms (25), profiles (26), probe/call (27) all reuse — get it clean here.
- `docs/futures/`: if rotation surfaces a "revisit-when" (e.g. bulk rotate, scheduled rotation) record it;
  note any new gotcha (mutation/SSR/CSRF edge) in `gotchas.md`.
- End with the 3-part end-of-increment report + run the handover **reflection** step (promote any
  recurring escape into a gate/skill/agent/behaviour).
