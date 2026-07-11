---
increment: 40
depends_on: [35, 36, 38, 39]
soft_after: []
touches: [core]
parallel_group: A
---

# Increment 40 — Google Calendar: deep catalog entry (LAST app in the push)

> **Source:** `docs/design/apps-ready-to-connect.md` §4 (the Google IA decision).
> The final app of the Apps redesign. Reuses **Gmail's Google groundwork** (inc
> 39): the shared Google OAuth provider is ALREADY restored — this increment does
> NOT touch `oauth/catalog.ts`. Mirrors Gmail's shape (inc 39) almost exactly.
> `core` authoring only; no web work.

## What / why

Author a **deep, honest, live-verified** Google Calendar catalog entry — a
SEPARATE `google-calendar` app sharing the ONE Google OAuth provider with Gmail
(the design's IA decision: surfaces partition per-service, only OAuth is shared).
Connectable via the inc-38 oauth2 bind, exactly like Gmail.

## Interfaces

- New `packages/core/src/apps/catalog/google-calendar/{catalog.json,help.json,tools/http.tools.json}`.
- **Google OAuth provider: ALREADY restored (inc 39) — do NOT re-add.** Calendar's
  `auth[]` references `{mode:"oauth2", providerId:"google"}` (the coverage guard is
  already satisfied by gmail; adding calendar just adds a 2nd app on the provider).
- Update the coverage-guard assertion in `catalog.test.ts` from
  `["github","gmail","slack"]` to include `google-calendar` (mind the ALPHABETICAL
  dir-sort order — the generator sorts, so it's `["github","gmail","google-calendar","slack"]`; confirm empirically).
- Glob-codegen: rebuild core → `gen:catalog` → rebuild core → web `gen:icons`.
  Do NOT hand-edit generated files.

## Surface to author (VERIFIED live this session — no fabrication)

### ONE surface: HTTP (oauth2-only) — the connectable programmatic surface

Mirrors Gmail (inc 39): Calendar's machine-readable description is a Google
**Discovery** doc (NOT OpenAPI 3.x), so junction's openapi-client can't parse it
→ ship an `http`-kind surface with hand-authored templates.

- `id:"google-calendar"`, `displayName:"Google Calendar"`,
  `supportedKinds:["http"]`, `auth:[{mode:"oauth2", providerId:"google"}]`
  (**oauth2-only** — Google issues no static token; a token mode = ~1h-broken
  promise. google `supportsRefresh:true` so oauth2 refreshes).
- `iconSlug`: try `"google-calendar"` / `"googlecalendar"` — CONFIRM the slug
  exists in the brand-icon library (`@thesvg/icons`) after `gen:icons`; if not
  available, use the correct real slug or the closest and NOTE it (Gmail's
  `"gmail"` resolved cleanly; calendar may differ).
- **http surface** `connection:{ kind:"http", baseUrl:"https://www.googleapis.com/calendar/v3" }`
  — **NOTE the baseUrl differs from Gmail**: Calendar's rootUrl+basePath =
  `https://www.googleapis.com/calendar/v3/` (verified live: Discovery `rootUrl`
  `https://www.googleapis.com/` + `basePath` `/calendar/v3/`), NOT
  `calendar.googleapis.com`. Trailing-slash: match how the tool paths are written
  (paths below start with `/calendars/...` relative to the base — set baseUrl to
  `https://www.googleapis.com/calendar/v3` with NO trailing slash and paths
  starting `/`).
- `build:{ platformIdTemplate:"{app}-{kind}", via:"descriptor", credential:{kind:"bearer", from:"auth"} }`.
- `verify:{ kind:"none" }` (no http verify hint — the schema gap from inc 39's
  revisit-when; `list_calendars`/get-primary is the cheap live probe).
- `displayName:"Google Calendar (HTTP)"`, `agentGuidance`, honest scope note.

### `tools/http.tools.json` — 6 templates (reuse HttpRequestToolSchema)

Verified live against the Calendar v3 Discovery doc (`events`/`calendarList`
methods confirmed present: events = list/get/insert/patch/delete; calendarList =
list). Use the REAL API operation → path mapping (create = `insert`, update =
`patch`). `{calendarId}` HARDCODED to `primary` where the intent is the user's
main calendar, OR exposed as a path param defaulting to `primary` (author's
choice — but if exposed, it's a calendar id the user owns, not a cross-account
risk like a userId; prefer hardcoding `primary` for the simple ops + a
`calendarId` path param on list/get where selecting a calendar matters). Validate
each against `HttpRequestToolSchema` (path placeholders required+named, ≤1 body
param, no body on GET).

| name | method + path | params |
|---|---|---|
| `list_events` | GET `/calendars/{calendarId}/events` | `calendarId`(path,required — default `primary` in the description), `timeMin`(query,string RFC3339), `timeMax`(query,string), `q`(query,string), `maxResults`(query,number), `singleEvents`(query,boolean), `orderBy`(query,enum: startTime/updated) |
| `get_event` | GET `/calendars/{calendarId}/events/{eventId}` | `calendarId`(path,required), `eventId`(path,required) |
| `create_event` | POST `/calendars/{calendarId}/events` | `calendarId`(path,required); one `body`(in:body) — description states the Event resource shape `{summary, start:{dateTime|date}, end:{dateTime|date}, ...}`; **`confirm:true`** |
| `update_event` | POST `/calendars/{calendarId}/events/{eventId}` (Calendar's `patch` is a PATCH verb — junction's http tool supports GET/POST/PUT/PATCH/DELETE? CONFIRM against HttpRequestToolSchema's allowed methods; if PATCH is allowed use PATCH, else use the correct verb the schema permits and NOTE it) | `calendarId`(path,required), `eventId`(path,required); `body`(in:body) partial Event; **`confirm:true`** |
| `delete_event` | DELETE `/calendars/{calendarId}/events/{eventId}` | `calendarId`(path,required), `eventId`(path,required); **`confirm:true`** |
| `list_calendars` | GET `/users/me/calendarList` | none — the user's calendar list (verified: `calendarList.list`) |

**CONFIRM the exact HTTP methods HttpRequestToolSchema allows** (read the schema
— it may be GET/POST only, or include PUT/PATCH/DELETE). If PATCH/DELETE aren't
supported, adapt: e.g. Calendar events also support full-`update` via PUT; and a
delete may need to be omitted or noted. Author only what the schema permits +
what the API really offers; NOTE any adaptation. No fabrication.

## `help.json`

- `category`: `["productivity", "calendar"]` (or match existing vocab).
- `homepage`: `https://calendar.google.com/` (verify).
- `statusPage`: `https://www.google.com/appsstatus/dashboard/` (same Google
  Workspace dashboard as Gmail).
- `description`: factual (Google Calendar — events, calendars, scheduling).
- `agentGuidance`: capability description; stable pinned ops.
- `oauthApp`: `{ registerUrl:"https://console.cloud.google.com/apis/credentials", callbackPath:"/oauth/callback/google" }` (same as Gmail — shared provider).
- `authSetup`: create OAuth client in Google Cloud Console, enable the Calendar
  API, request calendar scopes.
- `provenance`: `{ authoredBy:"junction", researchedFrom:[the cited Google Calendar docs URLs + the Discovery URL], lastReviewed:"2026-07-11" }`.
- `notes`: mirror Gmail's honest omissions — (1) Discovery-not-OpenAPI (openapi
  omitted), (2) no user-data CLI (CLI omitted — `gws` disclaims official status),
  (3) official remote MCP `calendarmcp.googleapis.com/mcp/v1` OMITTED (Dev-Preview
  + the mcp-`authHeader` bearer path unproven — same as Gmail), (4) no GraphQL.

## Scopes

Calendar scopes (verify against `https://developers.google.com/identity/protocols/oauth2/scopes#calendar`):
`.../auth/calendar` (full RW), `.../auth/calendar.readonly`,
`.../auth/calendar.events`, `.../auth/calendar.events.readonly`. Read ops need
readonly; create/update/delete need the RW/events scope.

## Omissions (documented, mirror Gmail)

- **OpenAPI/REST full surface — OMIT** (Discovery ≠ OpenAPI 3.x; `revisit-when`:
  Discovery→OpenAPI adapter or Google OpenAPI 3.x — the Gmail entry already filed
  this; confirm it's general enough to cover Calendar or add a Calendar line).
- **GraphQL — OMIT** (none). **CLI — OMIT** (no user-data CLI).
- **Official remote MCP (`calendarmcp.googleapis.com/mcp/v1`) — OMIT** (Dev-Preview
  + mcp-bearer gap; `revisit-when` mirrors Gmail's — add a Calendar line to the
  existing Gmail remote-MCP revisit-when entry or a parallel one).

## Proof-of-done

- `pnpm verify` green (if the quickjs/perms/audit parallel-flake appears — see
  `gotchas.md` — re-run; it clears).
- `listApps()` → `[github, gmail, google-calendar, slack]` (alphabetical);
  `listProviders()` still includes `google` (already there from inc 39).
- **No fabrication:** every value traces to a primary source; the Discovery doc
  (`https://calendar-json.googleapis.com/$discovery/rest?version=v3` — GET 200,
  168,117 bytes) + each tool path re-confirmed; note shape-verified vs live-tested
  (a live Google token is unlikely in the build env — shape-verify against the
  Discovery `flatPath` at minimum).
- **Orchestrator real-server QA (agent-browser):** `/app/google-calendar` renders
  rich (category, homepage/status, authSetup, the omission notes exist in data);
  exactly ONE "Google Calendar (HTTP)" Connect card (NO openapi/graphql/cli/mcp);
  the guided-oauth2 flow renders register-app + BYO-creds + callback
  `/oauth/callback/google` + one-click; adversarial secret sweep clean.
- Reviewers: junction-clean-code (no-fabrication — re-verify the paths/enums/URLs
  live) + junction-credential-security (no secret in the catalog; the tools carry
  no token; oauth2-only correct; no cross-calendar exfil beyond the user's own).

## Not in scope

Re-adding the Google provider (already restored, inc 39). Any web-component
change. openapi/graphql/cli/mcp surfaces. The `help.notes` render gap (inc-39
revisit-when — a separate UI increment).

## Completes the push

After this, the Apps "ready to connect" redesign's first push is DONE: GitHub +
Slack + Gmail + Google Calendar, each a deep honest connectable app, on a catalog
that one-click-connects both token AND OAuth-only services.
