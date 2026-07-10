---
increment: 36
depends_on: [35]
soft_after: []
touches: [core, web]
parallel_group: A
---

# Increment 36 — GitHub gold-standard: the 3 reusable "ready to connect" components

> **Source:** `docs/design/apps-ready-to-connect.md` (§3 components, §6 proof,
> §7 build order). This is the first *build* slice of the Apps redesign. It ships
> the **3 reusable components** the later app slices (37 Slack, 38 Gmail, 39 GCal)
> reuse, and proves them on **GitHub** — the one app that survived the inc-35
> strip-down and is authored deeply (help.json + tools + 5 surfaces).

## What / why

Today `/app/:id` is a surface inventory. This slice turns it into a **setup
destination** for GitHub, building the reusable machinery for all future apps:

1. **Two-mode connect panel** — an explicit toggle: **"I already have
   credentials"** (fast paste-and-connect) vs **"Help me set this up"** (guided,
   per auth type). Reusable, catalog-data-driven.
2. **CLI/sandbox explainer** — honest to junction's real execution model (host
   binary at a pinned absolute path, sandboxed, you-install-it, credential as one
   env var).
3. **Rich-data render** — surface the app-level `help` fields the DTO already
   carries but the page ignores (install, authSetup, homepage, statusPage,
   category, description, agentGuidance, oauthApp.registerUrl).

Plus the **sovereignty signals** (design §1a), implemented *lightly*: show where
the token lives, surface the sandbox boundary, lead with "you already have this."

## Load-bearing facts (verified — build on these, don't re-derive)

- **The DTO already carries the rich data.** `AppDetail.app.help?: AppHelp`
  (`packages/web/src/server/data.server.ts:591`) is populated end-to-end
  (`:717`). So **Component 3 is pure client rendering** — NO new server-fn, NO
  DTO change, NO core change. The `help` object (install/authSetup/homepage/
  statusPage/category/description/agentGuidance/oauthApp) is already at the page.
- **The connect path exists and is verify-gated.** `ConnectSurfaceDialog` +
  `connectSurfaceFn` (`app.$id.tsx:48`) already do token/byo → verify-**before**-
  commit; oauth2 → deep-link to `/credentials`. Component 1 **extends** this
  dialog into two explicit modes; it does not replace the write path.
- **The real sandbox model** (verified in `sandbox/{seatbelt,bubblewrap}.ts`,
  `sources/cli/provider.ts`, `schema/cli-connection.ts`): host binary,
  operator-pinned **absolute** `argv[0]` (no PATH in the sandbox), Seatbelt
  (macOS) / bubblewrap (Linux); deny-default FS reads; scrubbed env allowlist;
  credential passed as **one env var**, never argv; the CLI's own config dir
  (`~/.config/gh`) is **confined away** → env-var token is the working path.
  Caveats to state honestly: CLI-tier `allowNet` validated-but-not-enforced;
  Seatbelt Apple-deprecated (forward path microVM). See `docs/futures/`.
- **`app.$id.tsx` is ~1042 lines** — already too big (single-purpose rule). This
  slice EXTRACTS the new components into their own files rather than growing it.

## Interfaces

- **No core change. No schema change. No new server-fn. No DTO change.** This is a
  web-presentation slice over already-flowing data + the shipped connect path.
- New web component files (client, `packages/web/src/components/`):
  - `connect-panel.tsx` — the two-mode panel (Component 1). Consumes
    `SurfaceView` + `AppDetail.app.help`; renders the mode toggle; delegates the
    actual write to the existing `connectSurfaceFn` / oauth deep-link.
  - `cli-sandbox-explainer.tsx` — the CLI/sandbox explainer (Component 2).
    Pure presentational; consumes `help.install` + a static, honest sandbox
    description. A "check if installed" affordance renders `help.install.verifyCmd`
    as copy-paste (v1: copy-paste only — NO server-side exec of the verifyCmd in
    this slice; running host commands from the web server is a boundary decision
    deferred to §"Open decisions").
  - `app-help-panel.tsx` — the rich-data render (Component 3): homepage/status
    links, category chips, description, agentGuidance, authSetup, oauthApp
    register link.
  - `sovereignty-note.tsx` — the light sovereignty signals (token-location line,
    sandbox-boundary summary). Small, reused.
- `app.$id.tsx` is refactored to compose these; net line count should DROP.

## Implementation plan (slices within the increment)

Small enough for one Sonnet builder; ordered so each step is independently
verifiable.

### Step 1 — Component 3 (rich render) + sovereignty note
Lowest risk (pure render of present data), highest passive value.
- `app-help-panel.tsx`: render `help.homepage`/`help.statusPage` as external
  links (rel=noopener), `help.category` as chips, `help.description` +
  `help.agentGuidance` as prose, `help.authSetup` (interactive/env/configPath) as
  a labeled block, `help.oauthApp.registerUrl` as the "register your OAuth app"
  link.
- `sovereignty-note.tsx`: a plain, quiet line — "This credential is stored
  encrypted on this machine and never leaves the process." Shown on a connected
  surface. (Design §1a "show where the token lives", implemented lightly.)
- Wire into `app.$id.tsx`. **Metadata-only** (no secret/token/build in the DOM —
  the inc-30.10/30.11 contract; help is already metadata).

### Step 2 — Component 2 (CLI/sandbox explainer)
- `cli-sandbox-explainer.tsx`: for a `cli`-kind surface, render:
  - The OS install commands from `help.install.commands` (brew/apt/winget) as
    copy-paste `MonoCode`.
  - The honest sandbox paragraph (host binary at pinned absolute path; isolated
    from filesystem; credential as one env var; does NOT use the CLI's own saved
    login). Reuse `sovereignty-note`'s sandbox-boundary summary.
  - `help.install.verifyCmd` as a copy-paste "check it's installed" line +
    `minVersion` if present.
  - Honest caveat slot (from surface `notes[]` if present).
- GitHub's `gh` surface exercises this (help.json already has install/verifyCmd/
  authSetup). NOTE the `GH_TOKEN` vs denylist quirk: the CLI credentialEnvVar
  denylist rejects `_TOKEN`-suffixed names — the explainer should show the
  authSetup env honestly but not imply junction will accept a denied var name
  (this is guidance text, not a connect action, so it's informational only).

### Step 3 — Component 1 (two-mode connect panel)
- `connect-panel.tsx`: an explicit segmented toggle **"I already have
  credentials" / "Help me set this up"** (visual treatment = a `frontend-design`
  call — segmented control preferred; keep restrained).
  - **Fast mode** ("already have credentials"):
    - token/byo surface → the existing paste-account+secret form → `connectSurfaceFn`.
    - oauth2 surface → paste existing client id/secret (deep-link hand-off to the
      shipped `/credentials` oauth flow, or the existing oauth connect entry) —
      **no new oauth write path**; reuse inc-29 `startConnect`/`startReconnectFn`.
    - cli surface → assume installed; go straight to the credential/env step.
  - **Guided mode** ("help me set this up"):
    - oauth2 → the register-your-app steps (deep-link `help.oauthApp.registerUrl`,
      the exact callback URL to copy = `help.oauthApp.callbackPath`, the scopes),
      THEN collapse to Connect once client creds are saved.
    - token → deep-link where to mint the token + which scopes (from
      `help.authSetup`), then the paste field.
    - cli → render Component 2 (the explainer) then the credential step.
  - The panel picks the right sub-flow from the surface's `auth[]` (first =
    default) + `AppDetail.app.help`.
- Replace/extend the current `ConnectSurfaceDialog` usage on `app.$id.tsx` with
  this panel. Keep the shipped guards (empty-secret, double-submit, verify-before-
  commit, duplicate-account) — do NOT regress them.

### Step 4 — compose + shrink `app.$id.tsx`
Refactor the route to compose the 3 components; delete the now-inlined dialog
markup the panel subsumes. Net lines down.

## Proof-of-done (drive the REAL built web server — `junction-web-verify`)

Green tests are NOT proof (STATE.md "green but blind" class). Using a temp
`JUNCTION_HOME`, drive the built server and assert:

- `/app/github` renders: description, category chips, homepage + status links,
  agentGuidance; the `gh` CLI surface shows install commands + the honest sandbox
  explainer + verifyCmd; every authored surface (mcp/graphql/http/cli; openapi is
  the >10 MB honest-capped state) shows correctly.
- The two-mode toggle works: "already have credentials" opens the fast paste path;
  "help me set this up" shows the guided steps for that surface's auth type
  (oauth2 register steps with the real callback path + scopes; token mint link;
  cli install).
- After a token connect (real GitHub token, verify-before-commit), the surface
  flips to connected and the sovereignty note ("stored encrypted on this machine,
  never leaves the process") renders.
- **Adversarial secret sweep:** no token / client secret / `build` recipe in the
  DOM / HAR / SSR-HTML (metadata-only contract holds).
- `pnpm verify` green; component tests for each new component (happy-dom + Testing
  Library — assert behavior: mode toggle switches content; cli explainer renders
  install commands; help panel renders links).
- Reviewers: junction-web (LEAD), junction-package-boundary, junction-credential-
  security (secret non-disclosure to the DOM), junction-clean-code.

## Open decisions (settle in-build or via a Fable escalation)

- **"Check if installed" — copy-paste vs live exec.** v1 = copy-paste only (no
  web-server host exec). Running the verifyCmd server-side crosses a real boundary
  (web server spawning host processes) and deserves its own design — deferred.
- **Two-mode visual:** segmented control vs tabs vs two cards — `frontend-design`
  at build time; keep it quiet/restrained (anti-AI-slop, Geist system).
- **oauth2 "fast mode" paste of existing client creds:** reuse the exact inc-29
  entry point; confirm there's a non-deep-link inline path or keep the deep-link
  (do NOT invent a new oauth write path — architecture-over-expedience).

## Not in scope

Authoring other apps (37+). Any core/schema/sandbox change. Live verifyCmd
execution. Networked serving. The oauth *mechanism* (reuse inc-29 as-is).
