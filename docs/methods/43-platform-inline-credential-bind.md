---
increment: 43
title: Phase 2 — platform setup binds/creates credentials inline
depends_on: [42]
soft_after: []
touches: [web]
parallel_group: A
---

# 43 — Phase 2: platform setup binds/creates credentials inline

North star: `docs/specs/2026-07-17-credential-platform-normalization.md`. Depends on Phase 1 (42):
credentials are now standalone with a `name` and nullable `platformId`. This phase realizes
**"credentials → platforms"**: when you set up a platform, you bind an existing credential or
quick create-or-update one — closing the CLI Full Access gap from inc 41. **Web-only, no schema
change.**

## What / why

After Phase 1 you can make secrets freely, but platform setup still doesn't connect one — you add
a CLI platform with a `credentialEnvVar` *name* and it silently has no secret until you visit
`/credentials`. This phase adds an inline credential step to platform setup, mirroring the
app-catalog **Connect** flow (which already does platform+credential together).

## Interfaces / changes

### 1. Inline credential section in Add-Platform (kind-aware)

Add a **Credential** section to the Add-Platform dialog. Two modes the user picks between:

- **Use existing** — a Select of standalone credentials of **compatible kind** (from Phase 1's
  vault; `listUnlinked()` + kind filter). Binding sets that credential's `platformId` to this
  platform (associate — Phase 1 made it nullable, so this is a plain update).
- **Create new (quick)** — inline **Name · Secret** (+ account label); kind derived from the
  platform's auth. **create-or-update (upsert)**: if a credential for this (platform, account)
  already exists, update its secret; else create — the "created or updated" behavior the user
  asked for.

**CLI Full Access** (the acute case, inc 41): the section sits after `credentialEnvVar` (the
name). On submit: `addFullAccessCliPlatformFn` installs the platform → the credential step binds
(existing) or upserts (new) with `kind: "env"`, linked to the just-installed `platformId`. No
secret / "skip" → public CLI, unchanged. **The platform is already known → no platform picker.**

**Other secret-based kinds** (mcp/openapi/graphql/http token/api-key): same section, kind derived
from the platform's declared auth.

**OAuth kinds**: NOT an inline secret — surface the existing **Connect** deep-link (unchanged from
today; Phase 3 normalizes the provider linkage, not this).

### 2. Reuse, don't reinvent

- Binding an **existing** credential → a small `linkCredentialToPlatformFn` (sets platformId) or
  reuse the profile-source path; verify-gated where the kind supports it.
- Creating **new** inline → reuse `addCredentialFn` (Phase 1 made platformId optional; here we
  pass it) with upsert semantics. Follow the `connectSurface`/`confirmThenAdd` verify + rollback
  precedent (best-effort platform delete only if this call created the platform).

## Files

- **Edit** `packages/web/src/routes/-components/cli-form/full-access-panel.tsx` + `platforms.tsx`
  (`handleFullAccessSubmit`) — inline credential section + upsert-on-submit.
- **Edit** the generic Add-Platform form for the other secret kinds (where the auth section is).
- **Add** a `linkCredentialToPlatformFn` (or extend `addCredentialFn` with upsert) in
  `packages/web/src/server/mutations.functions.ts` / `platform-mutations.*`.
- Tests: CLI Full Access install with an inline new secret → platform installed AND credential
  bound in one flow (real-DB `withTempHome`); "use existing" binds a standalone credential;
  upsert updates rather than duplicates; OAuth path still shows Connect (unchanged).

## Constraints

- **No schema change** — Phase 1 already made platformId nullable; this only sets it.
- Never a platform picker inside credential creation — the platform is contextual (you're in it).
- Reuse the verify-gated create + rollback pattern; don't fork it. `docs/rules/` + `docs/rules/web.md`.

## Proof-of-done

- Add a CLI Full Access platform with a token entered inline → platform installed AND credential
  bound, one flow, no separate page, no platform picker (driven on the real server,
  `junction-web-verify`). This is the concrete inc-41 gap, closed.
- "Use existing" binds a Phase-1 vault credential; re-submitting the same (platform, account)
  updates rather than duplicating.
- `pnpm verify` + knip + depcruise + dup green.
