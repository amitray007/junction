# Credential ⇄ Platform ⇄ Provider — normalization (north star)

_Status: DESIGN (approved direction, user 2026-07-17). Built in 3 ordered phases:
increments 42 → 43 → 44. Source of truth for the "credentials → platforms → profiles"
re-architecture._

## The problem

The Platform ⇄ Credential relationship is **over-linked**, and it makes the whole setup feel
backwards:

- **Creating a credential forces you to pick a platform first.** `credential.platformId` is a
  required FK, so the `/credentials` "Add" dialog is a platform-picker. You can't just "add a
  secret."
- **Credentials also carry a provider link** (`oauthMeta.providerId`) — a *denormalized* copy of
  something the app/platform already declares (`app.auth[].providerId`).
- **Platform setup doesn't bind a credential** — you add a platform (e.g. a CLI with
  `credentialEnvVar`), then go to a *different* page to create the secret. Chicken-and-egg.

## The target model — three layers, plus global auth designs

```
   auth designs (global)          credentials (standalone secrets)
   OAuth providers:                {name, kind, value(s)}
   github/google/slack/generic         no platform, no provider link
        │                                   │
        └──────────► platforms ◄────────────┘
                     (reference a design + bind a credential)
                              │
                          profiles
                     (compose platforms into agent sources)
```

- **Auth designs (OAuth providers)** — already exist in `oauth/catalog.ts` as first-class
  `OAuthProvider` records (auth/token endpoints, refresh, scopes, `registrationHint`, response
  parser: github/google/slack + a **generic** escape hatch). Global and reusable. This layer is
  ~90% built; the normalization just stops credentials from denormalizing it and (Phase 3)
  exposes managing generic/custom designs.
- **Credentials** — become **pure secrets**: `{name, kind, value(s)}`. **No platform link, no
  provider link.** CRUD freely on their own page. The vault.
- **Platforms** — reference an auth design (how to authenticate) and bind a credential (the
  secret). This is the *only* place platform + design + credential meet.
- **Profiles** — reference `{platform, credential}` into namespaced agent sources. Unchanged.

## Invariants preserved (non-negotiable)

- **Multi-account wedge** — many credentials usable per platform; the profile-source picks the
  account. (A platform is not tied to one account.)
- **Secrets never leave the process** — credentials remain secrets-as-references; the MCP
  endpoint never returns values. This normalization is about *linkage*, not secret handling.
- **OAuth still works** — the OAuth exception *dissolves* under this model: an OAuth credential
  is no longer "born from a platform"; it is tokens produced by running a global design. The
  "how to refresh" lives in the design, sourced from the platform at use-time (see below).

## The one load-bearing technical fact (Phase 3)

OAuth **refresh** (`oauth/refresh.ts`) today reads `credential.oauthMeta.providerId` to know how
to refresh. Making credentials linkage-free means refresh must source the provider from the
**platform** instead. **This is feasible today**: `resolve-provider.ts` already resolves the
`platform` for a source *before* the credential (line ~70), so the platform is in hand at refresh
time. Phase 3 re-points refresh at `platform`'s declared design; a manually-added OAuth platform
must carry a provider reference for this to hold. This is the hinge Phase 3 must land carefully
(data-migration reviewer required).

## Phasing (each ships standing-alone value)

- **42 — Phase 1: credentials become standalone secrets.** `platformId` nullable; credentials
  gain a first-class identity (name); `/credentials` becomes pure `{name, kind, value}` CRUD with
  no platform picker. Raw kinds only (api-key/bearer/env/file). *Resolves the felt pain now.*
- **43 — Phase 2: platform setup binds/creates credentials inline.** Pick an existing standalone
  credential of compatible kind, or quick **create-or-update** one inline (the CLI Full Access
  gap from inc 41). Realizes "credentials → platforms."
- **44 — Phase 3: OAuth designs first-class + credentials shed `providerId`.** Refresh sources
  the provider from the platform's design; expose managing generic/custom OAuth designs; migrate
  existing OAuth credentials. *The hardest phase — does the refresh re-sourcing.*

## Migrations (overview)

- **42**: `credentials.platform_id` NOT NULL → nullable (SQLite table-rebuild). Existing rows keep
  their platformId (back-compat). Add credential identity/name.
- **44**: relocate/derive `oauthMeta.providerId` → platform-sourced; back-compat for existing
  OAuth rows. Data-migration reviewed.

Phases 42 and 43 do **not** touch OAuth (it keeps working exactly as today until Phase 44).
