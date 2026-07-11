---
increment: 37
depends_on: [35, 36]
soft_after: []
touches: [core, source-runtime]
parallel_group: A
---

# Increment 37 — Slack: deep catalog entry (first app reintroduced)

> **Source:** `docs/design/apps-ready-to-connect.md` §7. The FIRST app reintroduced
> under the deep standard after inc-35's strip-down. Reuses the inc-36 components
> (no web-component work — the page renders this data automatically).

## What / why

Author a **deep, honest, live-verified** Slack catalog entry — the anti-Composio
"we pre-solved the integration homework" promise, made concrete. Every value is
verified against a primary Slack source (URLs in this file); **no fabrication.**

This is a **`core` authoring increment** (catalog data + re-adding the Slack OAuth
provider) — it does NOT touch the web components (inc 36 already renders any
catalog entry). The proof is: `/app/slack` goes from an honest-empty fallback to
a rich, connectable page.

## Interfaces

- **No schema change. No web-component change.** New catalog files under
  `packages/core/src/apps/catalog/slack/` + re-added Slack OAuth provider in
  `packages/core/src/oauth/catalog.ts` + the restored `parseSlackTokenResponse`
  + the restored `verify-credential.ts` slack branch.
- The catalog is glob-codegen: after authoring, `pnpm --filter @junction/core
  build && pnpm --filter @junction/core gen:catalog`, then rebuild core so
  `dist` + web `gen:icons` see it. **Do NOT hand-edit `catalog.generated.ts`.**

## Surfaces to author (VERIFIED — decisions settled)

### 1. OAuth provider — RESTORE from git (faithful, was verified when added)

Re-add the Slack `OAuthProvider` to `oauth/catalog.ts`, restored verbatim from
git history (`git show 7303f1d~2:packages/core/src/oauth/catalog.ts`, the
`id: "slack"` block, saved at
`scratchpad/slack-provider-original.txt`). Also restore:
- `parseSlackTokenResponse` (the `{ok:false}`-at-200 parser) — needed again.
- The `verify-credential.ts` `provider.id === "slack"` branch (reads the body to
  reject `{ok:false}` at HTTP 200; every other provider's 2xx means live). Saved
  reference in scratchpad.

Restored values (all re-verified live this session):
- authorize `https://slack.com/oauth/v2/authorize` (200) · token
  `https://slack.com/api/oauth.v2.access` (POST) · scopeSeparator **`,`** ·
  `client_secret_post` · userinfo `https://slack.com/api/auth.test` (live:
  returns `{ok:false,error:"not_authed"}` unauthenticated — the exact quirk).
- registrationHint scopes: `channels:read,chat:write` · docsUrl
  `https://api.slack.com/authentication/oauth-v2` (note: `api.slack.com` docs now
  302 → `docs.slack.dev`, but the registration/app-management host is unchanged).

The **coverage guard** (`catalog.test.ts:107`) requires this provider to have a
backing App — the new slack catalog entry's `auth[]` provides it. Update
`oauth/catalog.test.ts` to re-include slack (restore the relevant assertions;
the inc-35 removal deleted them — git history has the originals).

### 2. REST / OpenAPI surface — SHIP (recommended/default; official, spec-backed)

- `specUrl`: `https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json`
  — **live-probed: HTTP 200, 1,237,332 bytes (~1.2 MB, well under the 10 MB cap).**
- `baseUrl`: `https://slack.com/api/`
- `verify`: `{ kind: "openapi", operationId: <the auth.test operationId in the spec> }`
  — `auth.test` is present in the spec; the builder must open the spec and read
  the exact `operationId` for `/auth.test` (do NOT guess it). `auth.test` needs
  no scopes and validates any token.
- `auth`: `[{mode:"oauth2", providerId:"slack"}, {mode:"token"}]` (a bot/user
  token works directly).
- `notes` (HONEST, required): "OpenAPI spec is **Swagger 2.0** (not 3.x) and the
  `slackapi/slack-api-specs` repo has been **archived (read-only since Mar 2024)**
  — stable but no longer tracking newer Web API methods. Many write methods
  (e.g. `chat.postMessage`) are POST form-encoded; the spec's GET declarations
  may not match — anchor verification on `auth.test`."
- `agentGuidance`: prefer REST for coverage + officialness.
- docs: `https://docs.slack.dev/apis/web-api/`.

### 3. MCP surface — SHIP the COMMUNITY server (Fable decision, disclosed + pinned)

Ship **korotovsky/slack-mcp-server** as a **stdio** MCP surface — the practical
self-host route (the official `mcp.slack.com/mcp` is OMITTED, see §Omissions).

- `connection`: `{ kind:"mcp", transport:"stdio", command:<pinned>, args:[<pinned VERSION>...], tokenEnvVar:"SLACK_MCP_XOXB_TOKEN" }`.
  - **PIN THE VERSION** in `args` — never `@latest` (a standing supply-chain
    exposure). Use the reviewed version (research: v1.3.0, May 2026). The builder
    must confirm the exact npx/docker invocation from the repo README and pin it.
    (`tokenEnvVar` is a plain string in the mcp schema — no `_TOKEN`-suffix
    rejection like the CLI kind — so `SLACK_MCP_XOXB_TOKEN` validates as-is.)
  - **Bot/user-token mode ONLY.** The XOXC/XOXD browser-session ("stealth") env
    vars MUST be **structurally absent** from the template (not just discouraged
    in a note — never present them).
- `displayName`: **"Slack MCP Server (community)"**.
- `auth`: `[{mode:"token"}]` (a bot token, `xoxb-`).
- `verify`: `{ kind:"mcp", listTools:true }`.
- `notes` (required, non-negotiable): "Community-maintained
  (korotovsky/slack-mcp-server), **not affiliated with or endorsed by Slack.**
  junction verified bot-token mode at v<pinned> on <date>. Version is pinned —
  review before bumping. Runs locally over stdio; the bot token is injected into
  the local process env and never sent to any third party. Bot/user-token mode
  only — the XOXC/XOXD browser-session 'stealth' mode is out of scope and
  security-sensitive."
- `agentGuidance`: MCP for curated conversational tools; REST for full coverage.

### Surface ordering: **REST first** (default), community **MCP second**.

## Omissions (documented knowledge, NOT silent drops)

- **GraphQL — OMIT.** Slack has NO official public GraphQL API (verified). Do not
  author it.
- **CLI — OMIT as a user-data surface.** The official `slack` CLI is
  **dev-tooling only** (create/deploy apps) — it **cannot post messages or list
  channels.** Record an honest `help.notes` entry: "Slack's official `slack` CLI
  is app-development/deployment tooling only — it cannot do user-data operations
  (post a message, list channels), so junction ships no CLI surface for Slack.
  (Also: the `slack` binary name can collide with other host tools.)" Do NOT
  claim a `brew install` (none is documented — no primary source).
- **Official MCP (`mcp.slack.com/mcp`) — OMIT the surface, record the rationale.**
  A surface is an executable connect promise; the official server restricts MCP
  to "directory-published or internal apps" and **prohibits unlisted apps**, so a
  self-hosted custom app cannot connect — shipping it would be a stub that fails
  at verify (fabrication-shaped). Record in `help.notes`: "Slack operates an
  official hosted MCP server at https://mcp.slack.com/mcp, but restricts MCP to
  directory-published or internal apps (unlisted apps prohibited) — unavailable
  to junction's self-hosted custom-app model as of <review date>." AND add to
  `docs/futures/revisit-when.md`: trigger — "Slack opens MCP to unlisted apps, or
  clarifies that a single-user self-host qualifies as an 'internal app' → author
  the official MCP surface and re-rank/retire the community one."

## `help.json` (app-level, all verified)

- `category`: `["communication", "chat"]` (pick from existing category vocab —
  check other entries' conventions).
- `homepage`: `https://slack.com/`
- `statusPage`: `https://slack-status.com/` (verified: `status.slack.com` 301 →
  this; use the FINAL url).
- `description`: a factual one-liner (team messaging / channels / DMs).
- `agentGuidance`: capability description (channels, messages, users); prefer REST
  for coverage, community MCP for curated tools.
- `oauthApp`: `{ registerUrl: "https://api.slack.com/apps", callbackPath: <the junction OAuth callback path> }`
  (match how github/help.json formats callbackPath).
- `install`: OMIT (no user-data CLI).
- `authSetup`: `{ interactive: "create an app at https://api.slack.com/apps, add scopes under OAuth & Permissions, install to workspace", env: "SLACK_BOT_TOKEN (xoxb-…)", ... }` — factual, no fabrication.
- `provenance`: `{ authoredBy:"junction", researchedFrom:[<the cited URLs>], lastReviewed:"2026-07-11" }`.
- `notes`: the CLI-gap note + the official-MCP-omission note (above).

## tools/ (starter tools) — OPTIONAL, only if this surface is the recommended path

§4.7 gap-filler rule: ship hand-authored `starterTools` ONLY where a surface is
the recommended path AND lacks a spec. Slack's REST has a spec; the community MCP
brings its own tools. So **no hand-authored tools/ needed** for Slack (unlike
GitHub's http-surface proof). Skip unless the build surfaces a real gap.

## Proof-of-done

- `pnpm verify` green (incl. the restored slack provider tests + the coverage
  guard passing with slack backed).
- `listApps()` → `[github, slack]`; `listProviders()` includes `slack` again.
- Every authored value traces to a cited primary source (no fabrication);
  spec URL + auth.test + endpoints re-confirmed live during the build.
- **Orchestrator real-server QA (agent-browser, per junction-web-verify):**
  `/app/slack` renders rich (description, category, homepage/status links,
  authSetup, the CLI-gap + official-MCP notes); the REST surface shows a Connect
  path with the OAuth/token two-mode panel; the community MCP surface shows
  "(community)" + the disclosure note; NO GraphQL/CLI surface; adversarial secret
  sweep clean.
- Reviewers: junction-package-boundary + junction-clean-code +
  junction-credential-security (the restored slack verify branch reads a response
  body — confirm it still leaks nothing, as the inc-35 review verified for its
  removal) + junction-mcp-contract (the community-MCP surface: pinned version, no
  stealth-token env, honest disclosure).

## Not in scope

Gmail/Calendar (38/39). Any web-component change. The official Slack MCP surface
(omitted, recorded). Hand-authored starter tools (none needed).
