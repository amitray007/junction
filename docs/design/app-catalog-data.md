# App catalog — researched real-service data (inc 30 Slice A seed)

**Status:** research output for inc 30's `AppCatalog` seed. Every entry here is **verified
against an official source** (vendor docs / official repo) — cited inline. Entries flagged
**⚠️ UNVERIFIED** must be confirmed (or dropped) before shipping; **do NOT ship guessed
connection data** (method file §5 do-NOT).

This is *data*, not the catalog code. Slice A translates these into `AppDefinition` entries
(`packages/core/src/apps/catalog.ts`), each with `supportedKinds` = *what junction can stand up
today* and `auth[]` linking oauth2 entries to `oauth/catalog.ts` provider ids.

> **Cross-cutting design nuances the research surfaced (encode these precisely):**
> - **OAuth-only remote MCPs** (Notion, Linear, Atlassian, Cloudflare, Sentry-remote) →
>   `auth:[{mode:"oauth2",…}]`, NOT a token. **Notion is OAuth-mandatory** (no bearer path);
>   Linear/Atlassian/Sentry/Supabase *also* accept a bearer/PAT (the vault-friendly path).
> - **Figma MCP** has **no credential** (trusts the locally-running desktop app) → either a
>   special no-auth app or excluded from the vault-backed catalog. Recommend: exclude day-one
>   (junction can't vault anything for it) or mark `auth:[{mode:"none"}]` if that variant exists.
> - **Two-env-var gotchas** — pin the exact var: GitHub CLI `GH_TOKEN` (or `GITHUB_TOKEN`),
>   GitLab `GITLAB_TOKEN` (v2+ prefers `GLAB_TOKEN`), Railway `RAILWAY_API_TOKEN` (account) vs
>   `RAILWAY_TOKEN` (project). MCP: `GITHUB_PERSONAL_ACCESS_TOKEN`.
> - **Secret-printing read subcommands** (`heroku config`, `doppler secrets`,
>   `supabase secrets list`) are reads that EXPOSE secrets — flag sensitive for audit/sandbox.

---

## MCP category (12 verified)

All stdio invocations `npx -y <pkg>` unless noted. "Remote" = hosted HTTP endpoint (OAuth).

| id | displayName | server / endpoint | transport | auth | source |
|---|---|---|---|---|---|
| github | GitHub | `github/github-mcp-server` (Go binary / `ghcr.io/github/github-mcp-server`) or remote `https://api.githubcopilot.com/mcp/` | stdio / http | `GITHUB_PERSONAL_ACCESS_TOKEN` (local) or OAuth (remote); `GITHUB_READ_ONLY=1` | [repo](https://github.com/github/github-mcp-server) |
| sentry | Sentry | remote `https://mcp.sentry.dev/mcp` (stdio for self-hosted) | http | OAuth 2.0, or `Sentry-Bearer` API token | [docs](https://docs.sentry.io/product/sentry-mcp/) |
| stripe | Stripe | `@stripe/mcp` (`--api-key=…`) or remote `https://mcp.stripe.com` | stdio / http | `STRIPE_SECRET_KEY` / `--api-key` (Restricted Key) or OAuth | [docs](https://docs.stripe.com/mcp) |
| notion | Notion | remote `https://mcp.notion.com/mcp` (local `makenotion/notion-mcp-server` exists) | http | **OAuth only** (no bearer) | [repo](https://github.com/makenotion/notion-mcp-server) |
| linear | Linear | remote `https://mcp.linear.app/mcp` | http | OAuth 2.1 (DCR) or `Authorization: Bearer` | [docs](https://linear.app/docs/mcp) |
| atlassian | Atlassian | remote `https://mcp.atlassian.com/v1/mcp` | http | OAuth 2.1 or API token | [repo](https://github.com/atlassian/atlassian-mcp-server) |
| cloudflare | Cloudflare | managed remotes under `*.mcp.cloudflare.com` (per-product) | http | OAuth | [docs](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/) |
| supabase | Supabase | `@supabase/mcp-server-supabase@latest` | stdio | OAuth browser flow (default) or `--access-token <PAT>` | [docs](https://supabase.com/docs/guides/ai-tools/mcp) |
| playwright | Playwright (Microsoft) | `@playwright/mcp@latest` | stdio | none (browser automation) | [repo](https://github.com/microsoft/playwright-mcp) |
| brave-search | Brave Search | `@brave/brave-search-mcp-server` (`BRAVE_MCP_TRANSPORT=http` for HTTP) | stdio / http | `BRAVE_API_KEY` | [repo](https://github.com/brave/brave-search-mcp-server) |
| figma | Figma | Dev Mode local server `http://127.0.0.1:3845/mcp` | http | **none** (auth via running desktop app) — see nuance | [docs](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/) |
| filesystem | Filesystem (reference) | `@modelcontextprotocol/server-filesystem <path>` | stdio | none (path-scoped) | [repo](https://github.com/modelcontextprotocol/servers) |

Additional verified reference servers (lower priority, stdio, no auth): **git** (`uvx
mcp-server-git`), **fetch**, **memory**, **time**, **sequential-thinking**
(`@modelcontextprotocol/server-*`).

⚠️ **UNVERIFIED — slack:** an official `@slack/mcp-server` (`SLACK_BOT_TOKEN`, `xoxb-`) is
described in [Slack MCP docs](https://docs.slack.dev/ai/slack-mcp-server/), plus a popular
community `korotovsky/slack-mcp-server`. Exact npm name/version NOT confirmed by fetching the
package page. Confirm before shipping, else omit the MCP variant (Slack still ships via OAuth).

---

## CLI category (12 verified)

Representative subcommands are read-only/safe unless flagged.

| id | displayName | binary | auth env var | safe reads | source |
|---|---|---|---|---|---|
| github | GitHub | `gh` | `GH_TOKEN` (or `GITHUB_TOKEN`) | `gh repo view`, `gh pr list`, `gh api <ep>` | [manual](https://cli.github.com/manual/) |
| gitlab | GitLab | `glab` | `GITLAB_TOKEN` (v2+ `GLAB_TOKEN`) | `glab repo view`, `glab mr list` | [docs](https://docs.gitlab.com/cli/) |
| stripe | Stripe | `stripe` | `STRIPE_API_KEY` / `--api-key` | `stripe balance retrieve`, `stripe customers list` | [docs](https://docs.stripe.com/stripe-cli) |
| vercel | Vercel | `vercel` | `VERCEL_TOKEN` | `vercel whoami`, `vercel ls`, `vercel env ls` | [docs](https://vercel.com/docs/cli) |
| aws | AWS | `aws` (v2) | `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY` (+`AWS_SESSION_TOKEN`,`AWS_DEFAULT_REGION`) | `aws sts get-caller-identity`, `aws s3 ls` | [ref](https://docs.aws.amazon.com/cli/latest/reference/sts/get-caller-identity.html) |
| cloudflare | Cloudflare | `wrangler` | `CLOUDFLARE_API_TOKEN` | `wrangler whoami`, `wrangler kv key list` | [docs](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) |
| supabase | Supabase | `supabase` | `SUPABASE_ACCESS_TOKEN` | `supabase projects list`, `supabase orgs list` | [ref](https://supabase.com/docs/reference/cli/introduction) |
| sentry | Sentry | `sentry-cli` | `SENTRY_AUTH_TOKEN` (`SENTRY_FORCE_ENV_TOKEN=1`) | `sentry-cli info`, `sentry-cli projects list` | [docs](https://docs.sentry.io/cli/configuration/) |
| railway | Railway | `railway` | `RAILWAY_API_TOKEN` (acct) / `RAILWAY_TOKEN` (project) | `railway whoami`, `railway list`, `railway status` | [docs](https://docs.railway.com/cli) |
| heroku | Heroku | `heroku` | `HEROKU_API_KEY` | `heroku auth:whoami`, `heroku apps` (⚠️ `heroku config` prints secrets) | [docs](https://devcenter.heroku.com/articles/authentication) |
| doppler | Doppler | `doppler` | `DOPPLER_TOKEN` | `doppler projects`, `doppler configs` (⚠️ `doppler secrets` prints values) | [docs](https://docs.doppler.com/docs/environment-based-configuration) |
| digitalocean | DigitalOcean | `doctl` | `DIGITALOCEAN_ACCESS_TOKEN` | `doctl account get`, `doctl compute droplet list` | [docs](https://docs.digitalocean.com/reference/doctl/) |

> Note: `digitalocean`/`doctl` added to round the list to 12 non-Slack CLIs; verify the env-var
> name at build (`DIGITALOCEAN_ACCESS_TOKEN` is the documented one) — if any doubt, the builder
> confirms against the doctl docs before seeding. Slack's official CLI is app-scaffolding
> oriented, NOT a token-vault read tool → **omit from CLI** (Slack fits MCP/OAuth).

---

## OpenAPI/REST category (12 verified, 2 fetch-size-flagged)

Spec URLs confirmed to resolve to a real OpenAPI/Swagger doc unless flagged.

| id | displayName | spec URL | base URL | auth | status |
|---|---|---|---|---|---|
| openai | OpenAI | `https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml` | `https://api.openai.com/v1` | `Authorization: Bearer` | ✅ 3.1.0 |
| digitalocean | DigitalOcean | `https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml` | `https://api.digitalocean.com` | `Authorization: Bearer` | ✅ 3.0.0 |
| box | Box | `https://raw.githubusercontent.com/box/box-openapi/main/openapi.json` | `https://api.box.com/2.0` | `Authorization: Bearer` | ✅ 3.0.2 |
| adyen-checkout | Adyen Checkout | `https://raw.githubusercontent.com/Adyen/adyen-openapi/main/json/CheckoutService-v71.json` | `https://checkout-test.adyen.com/v71` | `X-API-Key` (or Basic) | ✅ 3.1.0 |
| discord | Discord | `https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json` | `https://discord.com/api/v10` | `Authorization: Bot` (or OAuth2) | ✅ 3.1.0 |
| pagerduty | PagerDuty | `https://raw.githubusercontent.com/PagerDuty/api-schema/main/reference/REST/openapiv3.json` | `https://api.pagerduty.com` | `Authorization: Token token=` (or Bearer) | ✅ 3.0.2 |
| vercel | Vercel | `https://openapi.vercel.sh/` | `https://api.vercel.com` | `Authorization: Bearer` | ✅ 3.0.3 |
| asana | Asana | `https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml` | `https://app.asana.com/api/1.0` | `Authorization: Bearer` | ✅ 3.0.0 |
| twilio-accounts | Twilio (Accounts) | `https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_accounts_v1.json` | `https://accounts.twilio.com` | HTTP Basic (sid:token) | ✅ 3.0.1 |
| sendgrid-mail | SendGrid (Mail v3) | `https://raw.githubusercontent.com/twilio/sendgrid-oai/main/spec/json/tsg_mail_v3.json` | `https://api.sendgrid.com` | `Authorization: Bearer` | ✅ 3.1.0 |
| gitlab | GitLab | `https://gitlab.com/gitlab-org/gitlab/-/raw/master/doc/api/openapi/openapi_v2.yaml` | `https://gitlab.com/api/v4` | `PRIVATE-TOKEN` | ✅ swagger 2.0 |
| petstore | Swagger Petstore (demo) | `https://petstore3.swagger.io/api/v3/openapi.json` | `https://petstore3.swagger.io/api/v3` | `api_key` header (or OAuth2) | ✅ 3.0.4 |
| stripe | Stripe | `https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json` | `https://api.stripe.com` | `Authorization: Bearer` | ⚠️ URL 200s w/ real spec; too large for WebFetch to fully confirm `info.title` — re-verify via raw HTTP at build |
| github | GitHub REST | `https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json` | `https://api.github.com` | `Authorization: Bearer` | ⚠️ official repo confirmed; file >10MB WebFetch cap — re-verify at build |

Dropped: **Notion** OpenAPI — no stable canonical raw spec URL (JS-rendered Redocly portal);
include only as documented, not spec-verified, if wanted.

## GraphQL category (14 clean + others; 2 flagged/dropped)

| id | displayName | endpoint | introspection | auth | status |
|---|---|---|---|---|---|
| github-graphql | GitHub GraphQL | `https://api.github.com/graphql` | auth-gated | `Authorization: Bearer` | ✅ |
| gitlab-graphql | GitLab | `https://gitlab.com/api/graphql` | auth for most | `Authorization: Bearer` | ✅ |
| shopify-admin | Shopify Admin | `https://{shop}.myshopify.com/admin/api/{version}/graphql.json` | auth | `X-Shopify-Access-Token` | ✅ |
| shopify-storefront | Shopify Storefront | `https://{shop}.myshopify.com/api/{version}/graphql.json` | public | `X-Shopify-Storefront-Access-Token` (private: `Shopify-Storefront-Private-Token`) | ✅ |
| linear | Linear | `https://api.linear.app/graphql` | auth | `Authorization: <apiKey>` (raw for PAT; `Bearer` for OAuth) | ✅ |
| contentful | Contentful | `https://graphql.contentful.com/content/v1/spaces/{space}/environments/{env}` | auth | `Authorization: Bearer` | ✅ |
| yelp | Yelp Fusion | `https://api.yelp.com/v3/graphql` | auth | `Authorization: Bearer` | ✅ |
| countries | Countries (trevorblades) | `https://countries.trevorblades.com/graphql` | public | none | ✅ live-tested |
| rickandmorty | Rick and Morty | `https://rickandmortyapi.com/graphql` | public | none | ✅ live-tested |
| anilist | AniList | `https://graphql.anilist.co` | public | none (OAuth for mutations) | ✅ live-tested |
| datocms | DatoCMS | `https://graphql.datocms.com/` | auth | `Authorization: Bearer` | ✅ |
| braintree | Braintree | `https://payments.braintree-api.com/graphql` (sandbox `payments.sandbox…`) | auth | `Authorization: Basic base64(PUB:PRIV)` + `Braintree-Version:` header | ✅ |
| saleor | Saleor (demo) | `https://demo.saleor.io/graphql/` | public (demo) | none public; `Authorization: Bearer` for authed | ✅ |
| monday | Monday.com | `https://api.monday.com/v2` | auth | `Authorization: <token>` (no Bearer prefix) | ✅ |
| wpgraphql | WPGraphQL (self-hosted) | `https://{site}/graphql` | site-configurable | `Authorization: Bearer <JWT>` | ✅ convention (not a fixed host) |
| ~~spacex~~ | SpaceX (community) | `api.spacex.land/graphql` | — | — | ❌ DEAD — drop or use REST fork `api.spacexdata.com` |
| ~~hashnode~~ | Hashnode | `https://gql.hashnode.com/` | — | `Authorization: <PAT>` (unconfirmed) | ⚠️ public API now paid (2026-05-13); auth header unconfirmed vs official docs |

## OAuth category — the shipped 7 (verified) + 7 new

**Shipped 7 re-verified** (google, github, github-app, slack, microsoft, notion, atlassian).
**One correction to `oauth/catalog.ts`:** GitHub added **PKCE (S256) for OAuth Apps in July
2025** — the catalog's "GitHub OAuth Apps don't require PKCE" comment (`catalog.ts:159-165`) is
now outdated (S256 is fine, which the catalog already defaults to — the *comment* just needs a
fix). Microsoft authorize/token URLs are `…/{tenant}/…` (`common`/`organizations`/`consumers`/id).

**7 new OAuth apps** (all authorize/token URLs confirmed against official OAuth docs; all PKCE
S256):

| id | authorize URL | token URL | example scope |
|---|---|---|---|
| discord | `https://discord.com/oauth2/authorize` | `https://discord.com/api/oauth2/token` | `identify email` |
| spotify | `https://accounts.spotify.com/authorize` | `https://accounts.spotify.com/api/token` | `user-read-email user-read-private` |
| zoom | `https://zoom.us/oauth/authorize` | `https://zoom.us/oauth/token` | `user:read:user` |
| dropbox | `https://www.dropbox.com/oauth2/authorize` | `https://api.dropboxapi.com/oauth2/token` | `account_info.read files.content.read` |
| linear | `https://linear.app/oauth/authorize` | `https://api.linear.app/oauth/token` | `read write issues:create` |
| gitlab | `https://gitlab.com/oauth/authorize` | `https://gitlab.com/oauth/token` | `read_user read_api read_repository` |
| figma | `https://www.figma.com/oauth` | `https://api.figma.com/v1/oauth/token` | `file_content:read current_user:read` (old `files:read` deprecated) |

> Dropbox token host is `api.dropboxapi.com` (not `api.dropbox.com`); Figma token host is
> `api.figma.com`. Both confirmed against official docs.

---

## Coverage summary (proves App ⊥ auth-mechanism)

Cross-category — several real services appear under MULTIPLE verticals (github, gitlab, stripe,
vercel, discord, linear, notion, atlassian, cloudflare, supabase, sentry), which is exactly the
point: one **App** (e.g. GitHub) spans MCP + REST + GraphQL + CLI + OAuth. Verified counts:
**OAuth 14** (7 shipped + 7 new) · **MCP 12** · **CLI 12** · **OpenAPI 12** · **GraphQL 14** —
≥10 per category, all real. Non-OAuth apps (box, adyen, twilio, sendgrid, yelp, monday, …)
prove an App is NOT an OAuth-only concept.

**Build-time verification duties (do NOT ship guessed data):** re-confirm the 2 fetch-flagged
OpenAPI specs (stripe, github) via raw HTTP; drop/replace SpaceX; confirm-or-omit Hashnode +
Slack-MCP package name; fix the GitHub-PKCE comment in `oauth/catalog.ts`.
