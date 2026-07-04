# Provider — a first-class "connect a service" concept (design proposal)

**Status:** DESIGN PROPOSAL for increment 30, pending user approval of the shape.
Supersedes the earlier "captured for revisit" version of this file. Written after a
design/brainstorm pass with the user (2026-07-04), an Opus research pass on comparable
tools (Nango / Composio / Pipedream / better-auth / Terraform / Backstage), and a full
codebase-touchpoint map. **The build is a later increment; this pass produces the design.**

> **Naming note:** this doc uses **App** for the new top-level concept (the thing a human
> calls "my GitHub") and reserves **Provider** for the existing OAuth *catalog* knowledge
> (`OAuthProvider` in `catalog.ts`). "App" is chosen over "Service" because **"service"
> collides with junction's ambient "source" concept** (`SourceRef`, `sources/`, "source
> kind") and is the most overloaded word in software; "App" matches the user's mental model
> ("my GitHub is an app/product") and Composio/Pipedream's term, with no code collision in
> this repo. See §9 (Naming). The user may pick a different label; the argument for the
> shape is independent of the name.
>
> **This draft was revised after an adversarial review** (2026-07-04). The recommendation
> moved from "add a grouping *column*" to **derive the grouping (no schema change)**, and the
> per-service page is now modelled around junction's **multi-account wedge** (a {vertical ×
> account} matrix), which the first draft wrongly collapsed to one credential. See §5, §7.

---

## 1. The observation that prompted it

While dogfooding the inc-29 OAuth connect flow, the user noticed junction mixes two ideas
that arguably shouldn't be mixed, and — sharpened in the design pass — that a whole layer
of the user's mental model has **no home in the data model**:

1. **Auth mechanism vs. service knowledge are entangled.** The pre-defined OAuth provider
   catalog (google/github/slack/…) lives *inside* the credential/OAuth layer
   (`packages/core/src/oauth/catalog.ts`), so "create an OAuth credential" is tangled up
   with "which pre-defined service is this."

2. **A "service" is not one thing — it has multiple verticals.** GitHub offers an **MCP**
   server, **OAuth**, a **REST/OpenAPI** API, a **GraphQL** API, and a **CLI** (`gh`).
   Today junction models only the *bottom* of that: a `Platform` row is
   "GitHub-as-MCP" **or** "GitHub-as-OpenAPI" — disconnected rows with **no notion that
   they are all GitHub**. The thing the user actually thinks about — **"my GitHub"** — is
   scattered across Platforms + Credentials with nothing tying it together.

The user's framing: a top-level surface of **inbuilt, supported services** you browse and
click into (`/service/github`, `/service/google`) to set up quickly — Credentials /
Platforms / Profiles stay as the honest, granular internals beneath it.

---

## 2. The orthogonality this makes legible

junction has three axes; two are modelled, one is missing:

| Axis | Where | Values | Meaning |
|---|---|---|---|
| **Platform kind** | `schema/platform.ts:17` | `mcp · openapi · graphql · cli · custom` | the **protocol** junction speaks |
| **Credential kind** | `schema/credential.ts:14` | `oauth2 · bearer · api-key · env · file` | **how** you authenticate |
| **Service** *(missing)* | — | github · google · slack · … | **which real-world service** this all belongs to |

Platform kind ⊥ Credential kind is **already true and already modelled** — an OAuth token
in a `Credential` genuinely works across any `Platform.kind` (HTTP bearer for
mcp/openapi/graphql; env-var for cli). The current UI can make it *look* like
"OAuth ⇒ MCP platform," which is wrong.

The **Service** axis is the genuinely missing one. It is orthogonal to both: one Service
(GitHub) spans several `Platform.kind`s (its verticals) and is reached via one or more
`Credential.kind`s (OAuth, or a PAT as bearer). Adding it is what lets junction say
*"here is **GitHub** — these are the protocols it offers and this is how it's authed,"*
instead of showing four unrelated platform rows and a loose credential.

---

## 3. What comparable tools do (research synthesis)

Every serious tool in this space converges on the **same 3-tier separation** (names differ):

| Tier | What it is | Nango | Composio | Pipedream | better-auth | junction today |
|---|---|---|---|---|---|---|
| **(i) Catalog / template** | pre-defined service knowledge: auth URLs, PKCE, scopes | **provider** (`providers.yaml`, a *file*) | **toolkit** | **app** | built-in social-provider helpers | OAuth catalog (`catalog.ts`) — **partial** (OAuth-only) |
| **(ii) Configured integration** | template **+ your client creds/scopes**, a stored entity | **integration** | **auth config** | (app config) | `slack({clientId,…})` config | *(absent — the gap)* |
| **(iii) Per-account connection** | one authorized account's tokens | **connection** | **connected account** | **connected account** | **Credential** | ✓ |

Key findings that steer the decision:

- **The middle tier is real** in every multi-tenant tool — but the reason it's a *stored
  first-class entity* is **reuse across many users' connections** (one dev OAuth app fans
  out to thousands of end-user connections). **That driver is largely absent single-user.**
  better-auth — the lightweight reference — models tiers (i)+(ii) as **config with no
  per-provider DB table**; only tier (iii) (accounts) is persisted. That is the template
  for junction's minimal shape.
- **Naming is a trap.** Composio *renamed* its middle tier from "integration" to "auth
  config" because "integration" was overloaded (it read as "the whole connected thing").
  The lesson: **don't name a new entity "Provider"** — reserve "Provider"/"catalog" for the
  static tier-(i) knowledge; if a configured entity ever lands, call it "Connection"/
  "Auth Config."
- **A plugin loader is not justified.** Nango — whose whole business is integration breadth
  — keeps provider knowledge as **YAML data, not plugins**. Plugin runtimes (Terraform,
  Backstage) exist to host **arbitrary executable behavior/isolation**, which
  OAuth/connection is not. A user-authored **provider definition as data** + the existing
  `generic` escape hatch (`catalog.ts:336`) gives ~90% of a loader's benefit at near-zero
  cost. **Rules option (c) out.**

Composio/Nango also *present* the top surface exactly as the user described: you see
**"GitHub"** (a toolkit/app) and its tools + auth hang off it — you don't start at a raw
credentials table. That validates the **Service-as-top-layer** IA.

---

## 4. The naming-collision surface (why the top layer must NOT be called "Provider" in code)

"Provider" already carries **six distinct meanings** in the codebase (from the touchpoint map):

1. **`ToolProvider`** — the source-runtime transport interface (`sources/provider.ts:49`, ~43 refs).
2. **Provider *builders*** — `buildProvider` / `makeResolveProvider` / `createProfileProxy` (`source-runtime`, `sources/proxy.ts:136`).
3. **Per-kind `create*Provider` factories** — `createMcpProvider` / `createOpenApiProvider` / … (~31 sites).
4. **`OAuthProvider` / `getProvider` / `listProviders`** — the OAuth catalog (`oauth/catalog.ts:34`) — the "pre-defined service" sense.
5. **"source provider" / dispatch-by-kind** — the architectural prose name for 1–3.
6. **OpenAPI "provider selection"** — runtime tag/op filtering.

A new user-facing entity named `Provider` in code would collide with all of these.
**Resolution:** the top-level concept is **`Service`** in code (`ServiceCatalog`, `ServiceId`,
`/service/:id`). "Provider" keeps meaning the OAuth catalog (sense 4) and the runtime
transport (senses 1–3). The **user-facing label** on the sidebar can still be "Services" (or
another word the user prefers) — it just must not be the code identifier `Provider`.

---

## 5. The design decision — depth: derive / group-column / owning-entity

This is the core architectural fork. Three shapes deliver the same top-level UX; they differ
in how much they touch the shipped, dogfooded schema. **The adversarial review moved the
recommendation from "add a grouping column" (G) to "derive the grouping, no schema change"
(G-minus)** — the doc's own "defer persistence until the need is felt" logic applies to the
*column*, not just to the owning entity.

All three read a new pure **App catalog** in `core` — the genuinely new knowledge (§6):

```
NEW in core (data, pure) — common to all shapes:
  AppCatalog — [{ id:"github", displayName:"GitHub",
                  supportedKinds:[mcp, openapi, graphql, cli],  // what junction can STAND UP (its capability, not GitHub's surface — see §6)
                  auth:{ oauth:"github" | bearer | … },         // → links to the OAuth catalog entry
                  setupHints… }]
```

### Option G-minus — **derive the grouping, no column** (recommended)

Group platforms+credentials under an App **in the read layer**, computed live — **no new
column, no migration, no backfill.** For OAuth credentials the key already exists and is
authoritatively written: `oauthMeta.providerId` ("github","google", `credential.ts:43`). For
non-OAuth platforms, group by a computed match against the App catalog (a pure function), and
bucket the unmatched honestly as "Other/Ungrouped."

- **Strictly more additive than G:** *zero* schema change → literally cannot regress, not
  just "structurally." Sidesteps the rot Findings 2+3 flagged: there is no derived-then-
  *persisted* key to drift; fixing the grouping function fixes history for free.
- **Delivers** the same browse-catalog + per-App pages + "my GitHub" view.
- **Graduates cleanly:** promote to a real `platforms.app` column (Option G) only when a
  *write-time* need appears (a user manual override the derivation can't express), and to an
  owning entity (Option E) only when reuse/multi-config earns it.
- **Cost:** the App catalog data + the grouping function + the new web surface. No data-layer
  risk at all.
- **Watch-item:** the grouping function is the new "green but blind" surface (STATE §3) — a
  wrong/loose match silently mis-groups or under-groups with no error. Mitigate with a
  **positive-control test** (assert a known GitHub platform+credential lands under the GitHub
  App) and by preferring the *authoritative* `providerId` over heuristic id-matching wherever
  it exists.

### Option G — **add a validated grouping column**

Same as G-minus but persist `platforms.app TEXT` (nullable, additive migration).

- Warranted **only** if a write-time need exists that derivation can't serve (manual override,
  or a platform whose App can't be computed). If added, it MUST have a **single validating
  writer** (`setAppTag(platformId, appId)` rejecting unknown app ids against the catalog) and
  **no free-typed path** — otherwise it rots into "everything's a string tag" (the exact risk
  the user raised). Backfill is a *one-time, user-confirmable* tagging, never the steady-state
  join key.
- Strictly more risk than G-minus for no additional user-visible value **today**. Recorded as
  the first graduation step, not the starting point.

### Option E — **A first-class App ENTITY that owns its children**

A new DB table where an `App` row **owns** its verticals (platforms) + connections
(credentials). Credentials/Platforms are reparented as children.

- **Strongest, most literal Composio/Nango model.** Best if the user's real intent is to
  *manage GitHub as one owned object* — register a GitHub OAuth app once and reuse it across
  several platforms/credentials as a managed unit.
- **But:** the single-user reuse driver is weak today; it's a **bigger rewrite** of the
  shipped schema + connect flow + a real migration that reparents dogfooded data — the
  "churn a proven layer before the need is felt" risk, with higher regression surface against
  the inc-29 flow.

### Recommendation

**Option G-minus (derive the grouping, no column).** It delivers the exact IA the user
described (browse supported apps → per-app quick-setup pages → "my GitHub" with its verticals,
internals kept reachable), matches single-user economics (better-auth ships the whole mental
model with no middle-tier table), and is **maximally additive** — zero schema change, so the
dogfooded inc-29 OAuth flow cannot regress and there is no derived-then-persisted key to rot.
G (column) and E (entity) stay recorded in `revisit-when.md` with explicit triggers
(**G:** a write-time override derivation can't express; **E:** >1 config per app, or
BYO-client reuse the user wants to manage as a unit, or user-authored app definitions). Held
loosely — if the user's stated intent is "manage GitHub as one owned object," **E** is the
honest call and we take it directly rather than deriving.

---

## 6. The second gap: there is no app→verticals knowledge today

The touchpoint map confirmed **nothing maps an app to which platform kinds junction can stand
up for it.** `catalog.ts` is OAuth-only (8 auth entries); `Platform.id` is a flat opaque,
**user-authored, free-form, required** string (`"github"`, `"openapi:acme"`,
`"my-mcp-server"` — `cli/commands/platform.ts:131`) with no app grouping. So the "supported
apps catalog" is **genuinely new knowledge**, not a re-presentation of the OAuth catalog:

- The OAuth catalog answers *"how do I OAuth against github?"*
- The **App catalog** must answer *"what is GitHub, which of its verticals (MCP / REST /
  GraphQL / CLI) can junction stand up, what does each need to set up, and how is it authed?"*

This is the real content-design work of inc 30. **Critical framing correction from the
review:** unlike `catalog.ts` — which encodes *stable OAuth protocol facts* (token URLs,
PKCE) that change on an RFC timescale and fail loudly — a service→verticals list encodes a
*product-surface* fact that drifts on the vendor's release cadence and **drifts silently**. A
hand-maintained "what GitHub offers" enumeration would be a maintenance trap that contradicts
junction's "curated small" philosophy.

**The fix: describe junction's CAPABILITY, not the vendor's surface.** The catalog field is
`supportedKinds` = *"which platform kinds junction can stand up for this app"*, derived from
what junction actually supports, not a claim about GitHub's external API catalog. That stays
true by construction (it changes only when junction adds a source kind or an app), and it's
honest ("here's what junction can do with GitHub" ≠ "here's everything GitHub offers").

Proposed minimal-but-real shape:

- Start with **the apps junction already proves** (github, google, slack, … the OAuth-8) plus
  the `generic`/BYO escape hatch, each annotated with the `supportedKinds` junction can stand
  up today and a short setup hint per kind.
- **Do NOT define "app" as "OAuth-capable app."** A pure MCP server or an internal OpenAPI
  host has no OAuth catalog entry but is still an App — so the App catalog must be its own
  thing that *references* the OAuth catalog for the OAuth case, not a re-presentation of it.
  (Otherwise §1's auth-vs-service entanglement silently returns.)
- Divergence is **data, not code** (mirror `catalog.ts`'s proven pattern).
- **Extensibility = data:** a user can add an app definition (the cheap slice of option c) —
  deferred unless it earns its place; the `generic`/BYO path covers "an app we didn't
  pre-tune" meanwhile.

---

## 7. The per-app page — a list of connections, with full lifecycle (core UX, DECIDED)

Two user decisions shape this (2026-07-04):

- **"Choose once" — a vertical is a CHOICE, not a checklist.** Connecting GitHub means
  picking *one* way to reach it (MCP **or** REST **or** GraphQL **or** CLI) + an account — not
  standing up every vertical. So the page is a **list of your connections**, not a dense
  every-vertical grid. (A user *may* add another way later, but it isn't the expected path.)
- **The multi-account wedge stays.** Accounts multiply: "work GitHub" + "personal GitHub" are
  distinct `Credential` rows (`credential.ts:3`, by `profileName`). The list has a row per
  account-connection.

So `/app/github` (connected) is:

```
GitHub                                                       [+ Connect]
───────────────────────────────────────────────────────────────────────
work       · via REST    · ● Connected · checked 2h ago         ⋯
personal   · via MCP     · ● Connected                          ⋯
────
each row = ONE account + the ONE way it's connected + live status
⋯ menu = the full lifecycle (below).   [+ Connect] = add another account.
```

### The connection lifecycle (the ⋯ menu) — mostly SURFACING shipped ops

The review + user asked for disconnect / reconnect / *replace-a-method* — thinking through what
a user needs over a connection's life shows most of it **already exists** (inc 24–29); the
per-app page is largely a new *surface* onto shipped operations, plus one genuinely new op:

| Operation | Status | Backed by |
|---|---|---|
| **Connect** (pick vertical + account, auth) | ✓ shipped | inc-29 connect flow |
| **Reconnect** (re-auth expired/revoked token) | ✓ shipped | inc-29 `startReconnect` + Reconnect badge |
| **Test connection** | ✓ shipped | inc-28.9 / inc-29 OAuth-native test |
| **Rotate** (new secret, same account) | ✓ shipped | inc-24 `rotateCredential` |
| **Rename** account label | ✓ shipped | inc-29 `renameCredential` |
| **Add another account** (wedge) | ✓ shipped | multi-account |
| **Disconnect / remove** | ✓ shipped | `removeCredential` + platform delete |
| **Change method** (this GitHub is REST → make it MCP) | ✗ **NEW** | see below |

**"Change method" is the one new op, and it is NOT atomic.** A REST connection and an MCP
connection are *different `Platform` rows with a different `Credential`* — so "replace the
method" = a **guided disconnect-then-reconnect via a different vertical**, ideally preserving
the account label and reusing the stored OAuth client creds (inc-29 already supports "reconnect
reuses stored client creds", PR #94) so the user needn't re-enter them. Design it as a guided
flow composing shipped ops, not a new core primitive — architecture-over-expedience says reuse
the proven connect/disconnect paths rather than invent a "mutate platform kind in place" op
(which would be a risky in-place rewrite of a dogfooded row).

### Empty state

**No connections yet:** the page's empty state is the **catalog CTA** — "GitHub — junction can
stand up MCP / REST / GraphQL / CLI. Connect via OAuth (BYO client + scopes) or paste a token."
Guided quick-setup (standard empty-state pattern; not a separate page).

All of this reads over the **same** underlying Platform + Credential rows (grouped live per
§5). The list-of-connections shape (not a grid) is **decided**; "Change method" as a guided
compose-of-shipped-ops is the recommendation (held loosely — could defer to a fast-follow if
inc 30 gets large).

---

## 8. Information architecture (sidebar)

Per the user's decision — the new App surface primary, internals reachable-but-secondary:

```
Dashboard
Apps            ← NEW primary surface (browse supported apps → /app/:id)
Audit
API Keys
Settings
── Advanced ──  (eyebrow/group)
Platforms       ← the honest granular truth, still fully reachable
Profiles
Credentials
```

This preserves junction's differentiator — **credential transparency** (granular, honest,
inspect-your-own-broker) — while giving the clean "my GitHub" mental model as the front door.
Composio-style *hiding* of the internals was explicitly declined (it sacrifices the
transparency that is junction's whole pitch as a self-hosted broker).

---

## 9. Naming

- **Code identifier for the new concept: `App`** (`AppCatalog`, `AppId`, `/app/:id`).
  Chosen over "Service" because **"service" collides with junction's ambient "source"
  concept** (`SourceRef`, `sources/`, "source kind") — a near-synonym naming a different
  layer — and is the most overloaded word in software (daemon, systemd unit, DI service, REST
  service; junction is *itself* a broker service, so `ServiceCatalog` reads as "catalog of
  junction's services"). "App" matches the user's mental model ("my GitHub is an app") and
  Composio/Pipedream's term, with no code collision in this repo. Ran the same six-collision
  audit that ruled out "Provider"; "App" passes.
- **"Provider" stays** = the OAuth catalog (`OAuthProvider`, `getProvider`) and the runtime
  transport (`ToolProvider`, `buildProvider`).
- **User-facing label:** "Apps" by default; the user may rename (candidates: Apps, Services,
  Connections, Integrations). If a configured *owning entity* is ever added (option E), it is
  named **"Connection"** — never "Provider" (Composio's rename lesson).

---

## 10. Codebase impact (each surface, for the eventual method file — reflects G-minus)

- **`core`:** new pure `AppCatalog` module (data + lookups: `getApp`, `listApps`, and a pure
  `groupByApp` function §5). **No schema change, no migration, no backfill** under G-minus —
  the grouping is derived live (prefer the authoritative `oauthMeta.providerId` over heuristic
  id-matching). **No change** to `OAuthMetaSchema`, `persistOAuthTokens`, refresh engine.
- **`source-runtime` / connect engine:** unchanged (the mint path is reused as-is).
- **cli:** optional `junction app` read command (list supported apps / show one) for the
  scriptable path (every interactive surface keeps a headless path — `docs/rules`).
- **web:** new sidebar entry + group; new `/app` index (catalog browse) + `/app/:id` route
  (empty-state CTA + wedge matrix, §7); data server-fns (`getApps`, per-app aggregation that
  groups platforms+credentials live via `groupByApp`); reuse inc-29 connect/reconnect fns
  underneath. The existing Platforms/Credentials/Profiles pages move into the "Advanced" nav
  group, otherwise unchanged.
- **Regression guards:** (1) verify against `/tmp/jt29ui` (GitHub + Google still Connected)
  that OAuth connect + refresh + badges are byte-identical after the change, driven against the
  real running server (`docs/behaviours/verify-the-artifact.md`); (2) a **positive-control
  test** on `groupByApp` — assert a known GitHub platform+credential lands under the GitHub App
  (guards the new "green but blind" grouping surface, STATE §3).

---

## 11. Open questions still to settle (in the method file, or with the user)

1. **Depth** — **G-minus** (derive, no column — recommended) vs **G** (validated column) vs
   **E** (owning entity). *Leaning G-minus; held loosely. Pick E directly if the intent is
   "manage GitHub as one owned object."*
2. **App-catalog richness on day one** (§6) — the OAuth-8 + generic/BYO, annotated with
   `supportedKinds`? Or a smaller proven set first? (Frame as capability, not vendor surface.)
3. **Per-app page** (§7) — DECIDED: a **list of connections** (account + the one chosen
   vertical + status + a ⋯ lifecycle menu), empty-state = catalog CTA. Remaining sub-call:
   ship **"Change method"** (guided disconnect+reconnect) in inc 30 or as a fast-follow.
4. **User-facing label** for the top surface (Apps / Services / Connections / Integrations).
5. **CLI surface** — does inc 30 add `junction app` read commands, or web-only this pass?
6. **Non-OAuth apps** — an App is NOT "an OAuth-capable service" (§6); confirm a pure MCP /
   internal-OpenAPI host is a first-class App (grouped, not dumped in "Other").

---

## 12. Recommendation summary

Build the **App** concept as a **new top-level surface (sidebar + `/app/:id` pages) over a
*derived* grouping (G-minus — no schema change) + a new pure `AppCatalog` data module** —
**not** a grouping column (yet), **not** a new owning DB entity (yet), and **not** a plugin
loader. This delivers the "browse supported apps → quick-setup → my GitHub with its verticals"
mental model the user wants, makes the App ⊥ Platform-kind ⊥ Credential-kind orthogonality
legible, keeps junction's granular transparency (internals reachable), models the
multi-account **wedge** honestly (a {vertical × account} matrix, §7), and is **maximally
additive** — zero schema change, so the dogfooded inc-29 OAuth flow is reached unchanged and
cannot regress. Graduate to a column (G) when a write-time override is needed, or an owning
entity (E) when reuse/multi-config earns it — both recorded in `revisit-when.md`. Hold the
depth decision loosely — if the user's real intent is to *manage an app as one owned object*,
option E is the honest architecture and we take it directly.
