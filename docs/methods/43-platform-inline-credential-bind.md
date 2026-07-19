---
increment: 43
title: Phase 2 — platform setup binds/creates credentials inline
depends_on: [42]
soft_after: []
touches: [core, source-runtime, web]
parallel_group: A
---

# 43 — Phase 2: platform setup binds/creates credentials inline

North star: `docs/specs/2026-07-17-credential-platform-normalization.md`. Depends on Phase 1 (42):
credentials are now standalone with a `name` and nullable `platformId`. This phase realizes
**"credentials → platforms"**: when you set up a platform, you bind an existing credential or
quick-create a new one — closing the CLI Full Access gap from inc 41.

> **Design authority.** Scope + binding semantics below are the ruling of a Fable product-owner
> subagent (per the user's standing "whatever Fable decides, we execute" directive), grounded in
> the post-42 code. **Two premise corrections from that pass reshaped this file** — the original
> draft was wrong on both:
> 1. **This is NOT web-only.** There is no existing "set an existing credential's platformId"
>    primitive; binding needs a new **core** op. Frontmatter is `touches: [core, web]`.
> 2. **Binding is NOT "a plain update".** Migration 0011 (inc 42) **dropped** the
>    `UNIQUE(platform_id, profile_name)` DB index — the only unique on credentials now is
>    `credentials_name_unique`. So the duplicate-account invariant is **app-level guard only**;
>    every op that sets `platformId` or `profileName` must carry the guard manually (as
>    `addCredential`/`renameCredential` already do). A naive `setPlatformId` would silently create
>    two same-account credentials on one platform with **zero DB pushback** — a real footgun.

## What / why

After Phase 1 you can make secrets freely, but platform setup still doesn't connect one — you add
a CLI platform with a `credentialEnvVar` *name* and it silently has no secret until you visit
`/credentials`. This phase adds an inline credential step to platform setup, mirroring the
app-catalog **Connect** flow (which already does platform+credential together).

## Structure: blocking core slice → web leaf slices

Per `docs/methods/_waves.md`: a small **core slice** lands first, alone, gated on `pnpm verify`;
the **web slices** fan out after. The core slice is the new bind primitive + its policy + tests.

---

## SLICE A (core, blocking — lands first)

### A1. `credentials.setPlatformId(id, platformId)` repo op

A single-column update mirroring the `setSecretRef`/`setName`/`setProfileName` mold exactly
(`packages/core/src/repositories/credentials.ts`): read-before-write via `fetchRowOrNotFound`,
returns the full updated `Credential`, typed not-found on a missing id, `mapDbError` on failure.
Only the `platform_id` column is modified. **No schema change** (Phase 1 already made the column
nullable; this sets it to a value).

### A2. `bindCredentialToPlatform(id, platformId)` core function — **structural gates only**

> **Package-boundary correction (verified in code):** `core` is HTTP-free and **cannot verify** —
> `verifyCredential` lives in `source-runtime`, and `addCredential` (core) does NOT verify; the
> `verifyThenAdd`/`confirmThenAdd` wrappers in `source-runtime` add verify around it. Bind follows
> the **identical split**. So core's `bindCredentialToPlatform` owns the *structural* gates + the
> write; **verify-then-commit is a `source-runtime` wrapper (A2b)**, not a core concern. Fable's R5
> "verify-then-commit" is correct as a behavior; it just lands in `source-runtime`, mirroring the
> existing add path — do not import verify into core.

A new core function owning the structural bind policy (do NOT shoehorn into `addCredential` — create
vs. associate are different operations; keep the seam clean per architecture-over-expedience). Gate
stack **in order**, each returning a typed error, then the write:

1. **not-found** — the credential id doesn't exist (surfaces the repo's typed `not-found`
   `{entity, id}`).
2. **kind-compat** — refuse a kind-incompatible credential via `isKindAccepted(platform, kind)`
   (the same check + bearer back-compat rule `addCredential` uses at `add-credential.ts:156`),
   returning the existing typed `kind-incompatible` `{requested, allowed}` error. **In core, not
   just the web Select** — validate-at-boundaries; any future caller (a CLI bind command, a Select
   bug) must hit the same gate.
3. **duplicate-account guard (app-level — REQUIRED)** — read `credentials.forPlatform(platformId)`
   and reject if any existing credential's `profileName` **exactly** matches the binding
   credential's (case-sensitive, untrimmed — the identical comparison `addCredential`
   (`add-credential.ts:185`) and `renameCredential` (`rename-credential.ts:78`) use), returning the
   existing typed `duplicate-account` `{platformId, account}` error. **This is the footgun guard** —
   post-0011 the DB will NOT reject a dup, so core must.
4. **write** — `setPlatformId(id, platformId)` (A1). Returns the updated `Credential`.

### A2b. `verifyThenBind` / `confirmThenBind` (`source-runtime`) — verify-then-commit wrappers

Mirroring `verifyThenAdd`/`confirmThenAdd` (`connect-from-catalog.ts`): where the kind supports
verification, verify the credential's existing secret **against the target platform** FIRST, then
call core `bindCredentialToPlatform` only on `{status:"ok"}` (+ persist `setVerifyState`); on
`auth-failed`/`unreachable` return the outcome with **ZERO writes** (no `setPlatformId`). The
verify-none kinds (http/cli/env) route through `confirmThenBind` → straight to core bind (honestly
unverified), exactly as `confirmThenAdd` handles them today. **There is no rollback** — verify-then-
commit is one clean write or none. The web/CLI edges call these wrappers, never core bind directly
for a verifiable kind (same as they call `verifyThenAdd`, never `addCredential` directly).

### A3. Tests (real-DB `withTempHome`)

**Core (`bindCredentialToPlatform`):**
- Each typed error path: not-found, kind-incompatible (bind an `env` credential to an OAuth
  platform → refused), duplicate-account (**the two-unlinked-same-account scenario**: two
  standalone credentials both with `profileName` "default", bind both to one platform → 2nd
  refused).
- Happy path: an unlinked credential binds, `platformId` is set, it now appears in
  `forPlatform(platformId)` and not in `listUnlinked()`.

**source-runtime (`verifyThenBind`/`confirmThenBind`):**
- Verify gating: `auth-failed`/`unreachable` → no write (credential stays unlinked); `ok` →
  committed + `setVerifyState`; `not-verifiable` (via `confirmThenBind`) → committed.

### A4. `docs/futures/gotchas.md` entry (REQUIRED — standing invariant)

Record: *post-0011 the duplicate-account invariant is **app-level only** (the
`(platform_id, profile_name)` DB unique is gone). Every op that mutates `platformId` OR
`profileName` MUST carry the `forPlatform`-scoped exact-match guard — `addCredential`,
`renameCredential`, and now `bindCredentialToPlatform`. A new such op without the guard silently
admits duplicate accounts.* This is now a credential-security/data-migration review checklist item.

---

## SLICE B (web — after core lands)

### B1. Inline credential section in Add-Platform (kind-aware)

A **Credential** section in the Add-Platform dialog, two modes:

- **Use existing** — a Select over `credentials.listUnlinked()` **pre-filtered by
  `compatibleCredentialKinds(platform)`** (pure UX filter; core A2 is the real gate). Choosing one
  binds via `bindCredentialToPlatformFn` (thin server wrapper over A2).
- **Create new (quick)** — inline **Name · Secret** (+ account label); kind derived from the
  platform's auth. **CREATE-only** (R4): calls `addCredentialFn` (passing this platform's id +
  derived name). On a `duplicate-account` collision, the UI does NOT silently overwrite — it
  surfaces an explicit two-step recovery: *"A credential for this account already exists — **use
  it** (bind) or **replace its secret**"*, where "replace" calls the existing **rotate** path
  (`rotateCredential`/`setSecretRef`) only after explicit confirmation. **No silent upsert anywhere**
  — Phase 1 moved identity to `name`; upsert-by-(platform,account) would resurrect the retired
  identity AND overwrite a live secret by accident (the secret store has no undo → correctness-over-
  speed forbids it).

### B2. CLI Full Access (the acute inc-41 gap — must-have)

The section sits after `credentialEnvVar` (the name). On submit: `addFullAccessCliPlatformFn`
installs the platform → the credential step binds (existing) or creates (new) with `kind: "env"`,
linked to the just-installed `platformId`. No secret / "skip" → public CLI, unchanged. **The
platform is already known → no platform picker.**

### B3. OAuth kinds — show Connect (unchanged)

OAuth platforms show the existing **Connect** deep-link (no inline secret). Phase 3 (inc 44)
normalizes the provider linkage; inc 43 leaves OAuth exactly as today.

### B4. Files

- **Add** `bindCredentialToPlatformFn` in `packages/web/src/server/platform-mutations.functions.ts`
  (+ `.server.ts`), a thin wrapper over the `source-runtime` verify wrapper (A2b) — which calls core
  bind (A2) — for verifiable kinds; core bind directly is fine for verify-none kinds via
  `confirmThenBind`. Core re-validates authoritatively.
- **Edit** `packages/web/src/routes/-components/cli-form/full-access-panel.tsx` + `platforms.tsx`
  (`handleFullAccessSubmit`) — the inline credential section (both modes + duplicate recovery UI).
- Web tests: CLI Full Access install with an inline new secret → platform installed AND credential
  bound in one flow; "use existing" binds a standalone credential; a `duplicate-account` collision
  shows the recovery UI (not a silent overwrite); OAuth path still shows Connect.

---

## Constraints

- **No schema change** — Phase 1 made `platformId` nullable; this only sets it. (But it is NOT a
  "plain" update — it carries the A2 gate stack.)
- Never a platform picker inside credential creation — the platform is contextual (you're in it).
- Reuse the verify-then-commit precedent (`connect-from-catalog.ts`); don't fork a write-then-revert
  path. `docs/rules/` + `docs/rules/web.md`.
- **Core enforces, UI filters** — kind-compat and duplicate-account are core gates; the Select's
  kind filter is convenience, never the enforcement point.

## Deferred (record in `docs/futures/revisit-when.md` at step 9)

| Deferred | Trigger to revisit |
|---|---|
| Generic Add-Platform credential section for **other** secret kinds (mcp/openapi/graphql/http/api-key) — the designated cut line if the increment runs long (→ 43.1) | A user installs a non-CLI secret-kind platform and hits the same no-secret gap |
| CLI `junction credential bind` command | First agent/headless flow needs bind (scriptable-paths rule forces it; the A2 core op makes the command thin) |
| Any upsert **core** primitive | NEVER — superseded by R4 (create + explicit-rotate); "upsert" is a UI conversation, not a core op |

## Proof-of-done

- Add a CLI Full Access platform with a token entered inline → platform installed AND credential
  bound, one flow, no separate page, no platform picker (driven on the real server,
  `junction-web-verify`). This is the concrete inc-41 gap, closed.
- "Use existing" binds a Phase-1 vault credential; a `duplicate-account` collision surfaces the
  explicit use-existing/replace recovery — never a silent secret overwrite.
- Binding an incompatible-kind credential is refused by **core** (typed `kind-incompatible`), not
  merely hidden in the UI.
- `pnpm verify` + knip + depcruise + dup green.
