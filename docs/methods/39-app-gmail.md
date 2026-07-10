---
increment: 39
depends_on: [35, 36, 38]
soft_after: [37]
touches: [core]
parallel_group: A
---

# Increment 38 — Gmail: deep catalog entry (Google groundwork)

> **Source:** `docs/design/apps-ready-to-connect.md` §4 (the Google IA decision)
> + §7. Reuses the inc-36 components (no web work). Establishes the **shared
> Google OAuth provider** + the **remote-MCP** and **Gmail-HTTP** patterns that
> inc-39 (Google Calendar) reuses.

## What / why

Author a **deep, honest, live-verified** Gmail catalog entry — a SEPARATE app
(`gmail`, its own `/app/gmail` page) that shares ONE Google OAuth provider with
Google Calendar (inc 39). Per the design's IA decision: the surfaces partition
per-service, only OAuth is shared. `core` authoring increment; no web change.

## Interfaces

- New `packages/core/src/apps/catalog/gmail/{catalog.json,help.json,tools/*.tools.json}`.
- **Re-add the shared Google OAuth provider** to `oauth/catalog.ts` (RESTORE from
  git — the `id:"google"` block, saved at
  `scratchpad/google-provider-original.txt`; also `git show 184d422~3:packages/core/src/oauth/catalog.ts`).
  It is byte-identical to the inc-35-removed original (Google OAuth was
  dogfood-verified when first added). Restore the deleted google assertions in
  `oauth/catalog.test.ts` (git history has them).
- **No schema change.** Uses existing `mcp`(http) + `http` surface kinds.
- Glob-codegen: after authoring, rebuild core → `gen:catalog` → rebuild core →
  web `gen:icons`. Do NOT hand-edit the generated files. (`gmail` iconSlug should
  exist in the brand-icon library — confirm; if not, use the nearest correct slug
  or note it.)

## Surfaces to author (VERIFIED + Fable-decided)

> **⚠️ DECISION 2 was REVERSED by Fable's final analysis** (verified in code):
> the official remote MCP is **OMITTED**, not shipped, because junction's catalog
> **build recipe cannot bind an oauth2 credential to a remote mcp/http surface**
> (`build-recipe.ts` `planConnect` routes `oauth2` → `oauth-handoff` only —
> mints a credential, emits NO mcp platform input; the mcp branch carries only a
> STATIC `authHeader`/`tokenEnvVar`). So a catalog-authored oauth2 remote-MCP
> surface would leave NO connected MCP source — a surface that doesn't connect,
> violating the executable-connect-promise rule. (The RUNTIME could inject the
> token — `resolve-provider.ts` refreshes+injects kind-agnostically — but the
> AUTHORING layer can't create the row. A static bearer can't rescue it: OAuth
> tokens expire ~1h and need vault refresh.) **So the HTTP surface is the PRIMARY
> programmatic surface; the remote MCP is documented-omitted.**

### Shared Google OAuth provider — RESTORE from git (dogfood-verified original)

Values (re-confirmed reachable this session): authorize
`https://accounts.google.com/o/oauth2/v2/auth`, token
`https://oauth2.googleapis.com/token`, `access_type:offline + prompt:consent`
(REQUIRED for a refresh token), `redirectMode:"loopback-ephemeral"`, userinfo
`https://www.googleapis.com/oauth2/v3/userinfo`. Restore verbatim.

Gmail's `auth[]` references `{mode:"oauth2", providerId:"google"}` — this is what
satisfies the coverage guard for the re-added google provider.

### 1. HTTP surface — SHIP 5 hand-authored templates (the PRIMARY programmatic surface)

Fable decision: NOT a third-party converted OpenAPI spec (no-fabrication —
junction can't vouch for someone else's Discovery→OpenAPI conversion), NOT
omit-entirely. Ship an `http`-kind surface with a small set of individually
author-verifiable templates. This is the ONE connectable programmatic surface
Gmail ships (the remote MCP is blocked — see the box above), so it carries the
programmatic promise. It is honest, fully junction-owned, and genuinely connects
(the Google OAuth provider already feeds bearer auth to http sources at runtime).

- `kind:"http"`, `connection:{ kind:"http", baseUrl:"https://gmail.googleapis.com" }`.
- `auth:[{mode:"oauth2", providerId:"google"}, {mode:"token"}]` (a token also
  works — NOTE: oauth2 here goes through the shipped oauth-handoff to mint the
  Google credential, then the http surface's bearer is fed from it at runtime;
  this DOES work for http surfaces, unlike the remote-MCP case — the http connect
  path binds the vaulted credential. token/byo → bearer directly.)
- `build:{ platformIdTemplate:"{app}-{kind}", via:"descriptor", credential:{kind:"bearer", from:"auth"} }`
  (http = descriptor path, like GitHub's http surface).
- `verify`: `{kind:"none"}` — NOTE: `VerifyHintSchema` has NO `http` variant
  today (Fable-flagged schema gap). Record in `docs/futures/revisit-when.md`:
  "add an http verify hint (probe a designated GET tool, e.g. `get_profile`) when
  the verify interpreter grows an http kind." Author-time live verification of
  each template (real token, real 200s) is MANDATORY before shipping.
- `displayName:"Gmail (HTTP)"`.
- **`tools/gmail.tools.json`** — the 6 templates (reuse `HttpRequestToolSchema`
  verbatim; `users/me` HARDCODED in paths — single-user broker, never expose a
  userId param; `confirm:true` on send). Shapes validated against the schema
  (path placeholders required+matched, ≤1 body param, no body on GET):

  | name | method + path | params |
  |---|---|---|
  | `list_messages` | GET `/gmail/v1/users/me/messages` | `q`(query,string, Gmail search syntax), `maxResults`(query,number), `pageToken`(query,string), `labelIds`(query,string) |
  | `get_message` | GET `/gmail/v1/users/me/messages/{id}` | `id`(path,required,string), `format`(query,enum: full/metadata/minimal/raw) |
  | `send_message` | POST `/gmail/v1/users/me/messages/send` | one `body`(in:body) param; description MUST state the JSON shape `{"raw":"<base64url RFC-2822 MIME>"}` and that the agent builds the MIME itself; **`confirm:true`** |
  | `modify_message` | POST `/gmail/v1/users/me/messages/{id}/modify` | `id`(path,required,string); `body`(in:body): `{"addLabelIds":[...],"removeLabelIds":[...]}` — archive = remove INBOX, mark-read = remove UNREAD, label |
  | `list_labels` | GET `/gmail/v1/users/me/labels` | none |
  | `get_profile` | GET `/gmail/v1/users/me/profile` | none — the cheapest verify probe |

- `agentGuidance`: stable pinned operations (search/read/send/modify/label).
- `notes`: "Hand-authored templates covering the Gmail agent core
  (users.messages + users.labels) — a curated subset, not full API coverage.
  `send_message`/`modify_message` require the `gmail.send`/`gmail.modify` scopes;
  a read-only grant will 403 them (honest scope note). Full REST coverage awaits
  a Discovery→OpenAPI adapter (see revisit-when)."

### Surface ordering: only the **HTTP** surface ships (the remote MCP is omitted — box at top). So `supportedKinds: ["http"]`.

## Omissions (documented knowledge, NOT silent)

- **Official remote MCP (`gmailmcp.googleapis.com/mcp/v1`) — OMIT, revisit-when.**
  Fable's verified finding: junction's catalog **build recipe cannot bind an
  oauth2 credential to a remote mcp/http surface** — `planConnect`
  (`build-recipe.ts:194`) routes `oauth2` → `oauth-handoff` (mints a credential,
  emits no mcp platform input), and the mcp branch carries only a STATIC
  `authHeader`/`tokenEnvVar`; a static bearer can't work (OAuth tokens expire ~1h,
  need vault refresh). So a catalog-authored oauth2 remote-MCP surface would
  present a Connect button that can't complete — a stub. (The RUNTIME already
  refreshes+injects oauth2 tokens into a remote-MCP bearer kind-agnostically —
  `resolve-provider.ts` — so the future work is AUTHORING-layer only.) It is also
  Developer Preview (pre-GA). `help.notes`: record that Google ships an official
  remote Gmail MCP (Dev Preview, OAuth) but junction can't yet expose it as a
  connectable surface (the connect recipe can't bind an oauth2 credential to a
  remote MCP), and the HTTP surface is the supported programmatic path meanwhile.
  `docs/futures/revisit-when.md` trigger: "Ship Gmail's official remote MCP as an
  mcp/http surface when BOTH (a) the catalog build recipe gains an oauth2→mcp/http
  binding (planConnect can emit an mcp platform input whose bearer is fed by an
  oauth2 credential — runtime injection already exists, authoring-layer only) AND
  (b) Google promotes the endpoint to GA."

- **OpenAPI/REST full surface — OMIT, revisit-when.** Gmail's machine-readable
  description is a **Google Discovery doc** (`https://gmail.googleapis.com/$discovery/rest?version=v1`
  — live-verified: GET 200, 216,510 bytes; HEAD 404s, GET-only), **NOT OpenAPI
  3.x**, so junction's openapi-client can't parse it. `help.notes`: state this.
  `docs/futures/revisit-when.md`: trigger — "Google publishes an official OpenAPI
  3.x spec, OR junction builds a Discovery→OpenAPI adapter (one adapter unlocks
  the WHOLE Google API family — the architecturally-better move than per-app
  third-party specs; consider once ≥3 Google apps want full REST)."
- **GraphQL — OMIT.** Gmail has no GraphQL API.
- **CLI — OMIT.** No officially-supported Gmail user-data CLI
  (`@googleworkspace/cli` "gws" exists but is "not an officially supported Google
  product" — don't claim it). `help.notes`: state this honestly.

## `help.json`

- `category`: `["communication", "email"]`.
- `homepage`: `https://www.google.com/gmail/` (verify final URL).
- `statusPage`: `https://www.google.com/appsstatus/dashboard/` (Google Workspace
  Status Dashboard — verify).
- `description`: factual (Gmail — email: messages, threads, labels, search).
- `agentGuidance`: capability description; prefer MCP for curated tools, HTTP for
  stable pinned ops.
- `oauthApp`: `{ registerUrl:"https://console.cloud.google.com/apis/credentials", callbackPath:<the junction callback> }`
  (Google OAuth clients are created in the Cloud Console — verify the exact URL;
  match github/help.json's callbackPath format).
- `authSetup`: factual — create OAuth client in Google Cloud Console, enable the
  Gmail API, request the Gmail scopes (gmail.readonly/gmail.send/gmail.modify/
  gmail.labels), download client id/secret.
- `provenance`: `{ authoredBy:"junction", researchedFrom:[the cited Google docs URLs], lastReviewed:"2026-07-11" }`.
- `notes`: the Discovery-not-OpenAPI note + the no-CLI note.

## Scopes

Gmail scopes for the surfaces (verify current names against
`https://developers.google.com/gmail/api/auth/scopes`):
`gmail.readonly`, `gmail.send`, `gmail.modify`, `gmail.labels`. `gmail.modify`
subsumes readonly/labels; the send surface needs `gmail.send`. Put a sensible
default in the provider/registrationHint or per-surface auth as the codebase
supports.

## Proof-of-done

- `pnpm verify` green (google provider restored + coverage guard passing;
  the http tools validate against HttpRequestToolSchema; the mcp-http surface
  validates).
- `listApps()` → `[github, slack, gmail]`; `listProviders()` includes `google`.
- **Author-time live verification (MANDATORY, no-fabrication):** each of the 6
  HTTP templates confirmed against `https://gmail.googleapis.com` (real Google
  OAuth token — if a live token isn't available in the build env, verify the
  path/method shapes against the Discovery doc's declared operations at minimum,
  and NOTE which were live-tested vs shape-verified). Discovery-doc size + MCP
  endpoint re-confirmed live.
- **Orchestrator real-server QA (agent-browser):** `/app/gmail` renders rich
  (category, homepage/status, authSetup, the Discovery-omission + no-CLI notes);
  the MCP surface shows "Developer Preview" + the hosted-by-Google disclosure;
  the HTTP surface shows its templates; NO openapi/graphql/cli surface;
  adversarial secret sweep clean.
- Reviewers: junction-package-boundary + junction-clean-code (no-fabrication) +
  junction-credential-security (the oauth2-token→remote-MCP-bearer path — confirm
  no token leak to the DOM/logs; the http-surface bearer).

## Not in scope

Google Calendar (39 — but this increment's google provider + remote-MCP + Google
help patterns are the groundwork it reuses). Any web-component change. A
Discovery→OpenAPI adapter (revisit-when). The full Gmail REST/openapi surface.
