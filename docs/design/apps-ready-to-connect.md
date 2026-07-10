# Apps: "ready to connect" — the setup-destination experience

_Design doc. Brainstormed 2026-07-10. Owner: junction. Source for a series of
per-app method files (see §7). Builds on inc 30 (Apps), 30.8 (catalog schema),
30.10 (surface-first `/app/:id`), 30.11 (catalog-driven connect), 30.12
(multi-surface / add-account), 29 (OAuth vault), 21 (sandboxed CLI source)._

---

## 1. The reframe

Today an app page (`/app/:id`) is a **surface inventory**: it lists which
surfaces exist and lets you probe/connect them. The catalog *schema* already
supports far more (install commands, auth-setup guidance, agent guidance,
homepage/status links, per-surface tools) — but almost none of it is **authored**
(only GitHub has a `help.json` + hand-authored tools; 26 of 54 apps are thin
stubs) and the page **doesn't render** the app-level `help` even where it exists.

This work makes the app page a **setup destination**: you land on `/app/gmail`
and the page's job is to get you *connected and working* — adapting to which
auth path the app uses and how ready you already are, teaching what you don't
know, and being honest about the one-time steps.

It is **presentation + authoring together**, done as **vertical slices — one app
at a time**. Each slice ships that app's complete data *and* its complete page.

**Non-negotiable (junction behaviours):** correctness/security over speed, the
better architectural decision over expedience, no fabricated catalog data (every
value live-verified against a primary source at authoring time).

## 1a. Positioning — the two layers, and why this is *not* Composio

junction has **two layers of user**, and the Apps layer is deliberately the
"easy button" *on top of* the power primitives — not a replacement for them.

- **The power layer (already built): Credentials · Platforms · Profiles.** An
  advanced user hand-wires any source — picks the surface, the toolFilter, the
  sandbox policy, the namespace. Full control, full effort.
- **The Apps layer (this work): the curated shortcut.** junction has *already
  done the integration homework* — which spec URL, which REST base, which MCP
  server/package, which OAuth scopes, which CLI binary + install command. The
  user clicks their platform and connects. They do **not** research "what's the
  Gmail REST base URL" or "which MCP package do I install" — **we pre-solved all
  of it in the catalog.** The only thing left to the user is the *irreducible,
  genuinely-theirs* one-time setup (register their own OAuth app, mint their own
  token, install their own CLI) — because **sovereignty requires the token be
  theirs.**

**The anti-Composio thesis (a hard design constraint, not a slogan):**

> Composio removes setup by **taking custody of your credentials** (their cloud
> holds your keys; they are the man-in-the-middle for every call).
> junction removes setup by **pre-packaging the integration knowledge** while
> **leaving custody with you** (encrypted, on your machine, never leaving the
> process).

So the catalog is **not** "a connector directory like Composio's." It is
**integration knowledge as a first-class artifact** — the pre-solved layer that
makes junction's sovereign primitives self-serve. This yields three constraints:

1. **We never compete on connector count.** Four deep, honest, sovereign app
   experiences beat 200 shallow ones. The instinct "we should have as many apps
   as Composio" is the wrong one — surface it and reject it.
2. **Every page element earns its place by expressing sovereignty or
   local-brokering** — where the token lives, what the sandbox confines, "you
   already have this" — not by matching a competitor's surface.
3. **The one-time setup steps are a feature, not a wart.** They are the visible
   cost of *you* owning the credential; the guided flow makes them painless, and
   the "I already have credentials" mode skips them entirely.

**Sovereignty design principles (bake in as direction; implement lightly in the
first slice — user decision "keep it simple for now"):**

- **Show where the token lives** — a connected app states, plainly, that the
  credential is stored encrypted on *this* machine and never leaves the process.
- **Surface the sandbox boundary** — make what junction confines / what the agent
  can and can't reach legible (most concrete for CLI; lighter for others).
- **Lead with "you already have this"** — the page assumes a self-hoster arrives
  with existing tokens/CLIs; the two-mode toggle (§3) makes that a first-class
  path, the opposite of start-from-zero-in-our-cloud.

## 2. Scope

**In scope — first push (4 apps, in build order):**

1. **GitHub** — most-authored today; becomes the gold standard proving every
   shared component.
2. **Slack** — its own OAuth; Web API REST; community MCP; *no* real user-data
   CLI (an honest gap). Proves "an OAuth app that isn't GitHub."
3. **Gmail** — Google OAuth (shared provider, scope-differentiated); Google
   Discovery-format REST; official **remote** MCP (Developer Preview). Solves
   the two hard Google problems.
4. **Google Calendar** — reuses Gmail's Google-provider + Discovery + remote-MCP
   groundwork; mostly authoring.

Across these four the full surface matrix junction supports is exercised: **MCP,
CLI, OpenAPI/REST, GraphQL, HTTP.**

**Out of scope (YAGNI):**

- The other ~50 catalog apps are **not** authored in this push. They benefit
  passively from the rich-render work (§3, Component 3) but stay as-is.
- **No new schema** — every field this needs already exists in
  `catalog-schema.ts`.
- **No new auth mechanisms**, **no sandbox changes**.
- Backfilling install/authSetup for all apps at once (a later, separate sweep).

## 3. Components (reusable; authored once, used by every app)

### Component 1 — The two-mode connect panel (centerpiece)

Every app page's connect area has an **explicit mode toggle** (user decision:
two explicit modes, not auto-detection, not always-collapsible):

- **"I already have credentials"** → fast path, paste-and-connect immediately:
  - *OAuth app:* paste an existing client ID/secret (or an existing token) → Connect.
  - *Token app:* paste the PAT/API key → Connect.
  - *CLI app:* junction detects an installed+authed binary → confirm → done.
- **"Help me set this up"** → guided path, per auth type:
  - *OAuth:* deep-link to the provider's "new app" page, the **exact callback URL
    to copy**, the **specific scopes** to request → then collapses into one-click
    **Connect** once client creds are saved.
  - *Token:* deep-link to where the token is minted, which scopes, then a paste field.
  - *CLI:* the OS-appropriate install command + how junction runs it sandboxed
    (Component 2).

One **shared web component**, driven by catalog data. This is the reusable heart
of the feature. It sits on top of the shipped inc-30.11 verify-**before**-commit
connect path (a wrong credential writes nothing).

**OAuth reality (honest):** junction is self-hosted single-user — there is no
shared junction OAuth app, so "click to OAuth" requires the user to register
their **own** OAuth app (BYO client ID/secret) with the provider **once**. The
guided path teaches exactly that one-time step; after the client creds are saved,
Connect is genuinely one click. The "I already have credentials" mode skips the
registration entirely.

### Component 2 — The CLI/sandbox explainer (honest to the real model)

Ground truth (verified in code — `sandbox/{seatbelt,bubblewrap,exec}.ts`,
`sources/cli/provider.ts`, `schema/cli-connection.ts`, `docs/methods/21-…`):

- junction **never installs or stages** a binary. It runs the **host's** binary
  at an **operator-pinned absolute path** (`argv[0]` must start with `/`; the
  sandbox has **no PATH**), wrapped in **Seatbelt (macOS) / bubblewrap (Linux)**.
- Confinement: deny-default FS reads (macOS) / bind-only mounts (Linux) limited
  to cwd + granted read/write paths + the binary's own dir; a **scrubbed env
  allowlist** (no host env, no host PATH on macOS); the credential passed as
  **one env var** (or a 0600 temp-file path for `kind:"file"`), never in argv.
- **The CLI's own config dir (`~/.config/gh`, `~/.aws`) is confined away** unless
  explicitly granted → the working credential path is the **env-var token**, not
  the CLI's ambient login.
- **Known caveats to state honestly:** CLI-tier `allowNet` is validated but **not
  enforced** by the harness (only the Deno/script tier enforces net); Seatbelt is
  Apple-deprecated (forward path: microVMs) — see `docs/futures/`.

So the guided CLI path says, plainly: *"Install `<bin>` yourself (here's the
command). junction runs it sandboxed from `<absolute path>`, isolated from your
filesystem, with the credential passed as one env var — it does **not** use your
CLI's own saved login."* A **"check if installed"** action runs
`help.install.verifyCmd` and shows ready/not-ready.

### Component 3 — The rich-data render (close the presentation gap)

The page renders the app-level `help` fields the schema **already has** and the
page ignores today: `description`, `agentGuidance`, `category`, `homepage`,
`statusPage`, `install`, `authSetup`, `oauthApp.registerUrl` — plus per-surface
`docs` / `agentGuidance` / `tools`. **No schema change**; pure presentation. This
is the one component that passively benefits all ~50 other apps.

### Component 4 — Per-app authoring (the data)

Each slice authors that app's `catalog.json` + `help.json` + `surfaces[]` +
`tools`, **all live-verified** (no fabrication — download specs, probe endpoints,
confirm install commands). Plus any page-rendering work its surfaces newly
exercise.

## 4. Information architecture: the Google decision

**Decision: separate `gmail` and `google-calendar` catalog apps, sharing one
Google OAuth provider.** (User-approved, evidence-grounded.)

Surface partition (research-verified, July 2026 — re-verify at authoring):

| Surface | Gmail | Google Calendar | GitHub | Slack |
|---|---|---|---|---|
| **OAuth** | Google (shared server, scope-differentiated) | Google (same server, different scopes) | GitHub own | Slack own |
| **REST** | gmail v1 Discovery, ~212 KB | calendar v3 Discovery, ~164 KB | GitHub REST (>10 MB — capped, honest) | Web API |
| **GraphQL** | ✗ | ✗ | ✓ `api.github.com/graphql` | ✗ |
| **MCP** | ✓ official **remote** `gmailmcp.googleapis.com` (Dev Preview) | ✓ official **remote** `calendarmcp.googleapis.com` (Dev Preview) | ✓ `github/github-mcp-server` | community |
| **CLI** | ✗ (no user-data CLI) | ✗ | ✓ `gh` | partial (`slack` = app-dev, not messaging) |

**Why separate apps:** 4 of 5 surfaces partition **per-service** (separate REST
Discovery docs, separate MCP endpoints, no shared user-data CLI). Only OAuth is
shared. junction's OAuth vault already keys by `providerId`, so two apps
referencing one Google provider is a supported mechanism, not new work. The user
thinks "Gmail," not "Google."

**Google surfaces — author ALL, including remote MCP** (user decision). Two hard
problems this pulls into the Gmail slice, each to be settled in its method file:

1. **Google Discovery ≠ OpenAPI 3.0.** The ~200 KB docs are Google's Discovery
   format, not an OpenAPI spec junction's openapi-client consumes. Method-file
   decision: **convert Discovery→OpenAPI** vs. **treat as HTTP starter-tool
   templates**. (Size is a non-issue — well under the 10 MB cap.)
2. **Official Gmail/Calendar MCP is remote OAuth-hosted (Dev Preview).** This is
   the normal junction remote-MCP path (the OAuth token lives in junction's
   vault; tool calls proxy to Google's hosted MCP) — consistent with brokering
   any remote MCP source. The page must label it **Developer Preview** honestly.

## 5. Architecture & boundaries

- **Data lives in `core`** (`packages/core/src/apps/catalog/<app>/`): pure,
  validated `catalog.json` / `help.json` / tools. No HTTP, no I/O.
- **Presentation lives in `web`** (`packages/web/src/routes/app.$id.tsx` +
  extracted components): renders catalog DTOs; **metadata-only** (no secret,
  token, or `build` recipe reaches the browser — inc-30.10/30.11 contract holds).
- **Connect runs through the shipped path** (`source-runtime/connect-from-catalog.ts`,
  verify-before-commit). No new write path.
- **Dependency direction unchanged:** web → core; core depends on nothing.
- **Each unit stays single-purpose:** the two-mode panel, the CLI explainer, and
  the rich-render each become their own focused component (the current 1042-line
  `app.$id.tsx` is a signal to extract, not grow).

## 6. Proof-of-done (per slice)

A slice is done when, driving the **real built web server** (per the
`junction-web-verify` skill — green tests are not proof):

- Both modes render and work: "already have credentials" connects in one paste;
  "help me set this up" shows the correct guided steps for that auth type.
- OAuth guided flow shows the real register URL, the exact callback URL, and the
  right scopes; after saving client creds, Connect is one click.
- CLI explainer states the real sandbox model; "check if installed" runs the real
  verifyCmd.
- All authored `help`/surface fields render; **no secret/token/build** reaches
  the DOM/HAR/SSR-HTML (adversarial sweep).
- Every authored catalog value traces to a cited primary source (no fabrication).
- `pnpm verify` green; boundary + credential-security + web reviewers clean.

## 7. Decomposition → method files (build order)

Each is its own increment method file under `docs/methods/`, following the
per-increment loop (research → method file → approve → Sonnet build → review →
user test → ship → log). The **shared components (§3) land in the GitHub slice**
and are reused thereafter.

1. **`NN-app-github-gold-standard.md`** — the 3 reusable components (two-mode
   panel, CLI/sandbox explainer, rich render) + GitHub's page as the proof. Also
   the honest ">10 MB OpenAPI, so REST surface capped" state.
2. **`NN-app-slack.md`** — Slack authoring; proves non-GitHub OAuth + honest
   "no user-data CLI" gap. Mostly data; reuses §3 components.
3. **`NN-app-gmail.md`** — Google OAuth provider (shared, scoped) + Discovery-REST
   decision + remote-MCP (Dev Preview). The hard Google groundwork.
4. **`NN-app-google-calendar.md`** — reuses Gmail's Google groundwork; authoring.

Increment numbers assigned when scheduled (34 Distribution stays excluded per
user directive).

## 8. Open decisions deferred to method files (not blocking this doc)

- Gmail/Calendar **Discovery→OpenAPI** conversion vs. HTTP-template treatment.
- Whether remote-MCP (Dev Preview) surfaces get a distinct "preview" badge
  component or reuse an existing note affordance.
- CLI "check if installed" — synchronous verifyCmd run vs. a cached probe.
- Whether the two explicit modes are a segmented control, tabs, or two cards
  (a `frontend-design` call at build time).
- How *lightly* to implement the §1a sovereignty signals in the first slice (the
  direction is fixed — token-location, sandbox boundary, "you already have this";
  the visual weight is a build-time `frontend-design` judgment, kept restrained).
