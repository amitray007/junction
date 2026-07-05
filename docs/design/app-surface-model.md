# App Surface Model — apps reached through multiple surfaces, one toolset for agents

> **Status:** design (brainstormed with the user, 2026-07-05). Successor to
> `docs/design/provider-concept.md` (inc-30's "App as a first-class concept").
> This doc captures the **whole vision**; it is built **incrementally** (see §8).
> Interactive mockup that drove it: junction `/app/github` surface-first prototype.

---

## 0. TL;DR

An **App** (GitHub, Google, …) is a real service junction reaches through one or
more **surfaces**. A surface is a *way to reach the service* — MCP, OpenAPI (REST
with a spec), GraphQL, HTTP (a REST API whose tools the user authors by hand), or
CLI. **OAuth/token are auth mechanisms, not surfaces** — they authenticate a
surface. (`grpc` is a researched candidate — §2.6.)

Every surface yields **named, typed tools** — they differ only in **who authors
the tool definitions**:

- **Auto-authored** (`mcp`, `openapi`, `graphql`) — junction gets the tools from
  the surface's own self-description (the MCP server's `listTools`, the OpenAPI
  spec, GraphQL introspection). No hand-authoring.
- **Hand-authored** (`http`, `cli`) — the **user/operator** declares each tool
  (name + method/command + params-with-location + description). For `http`, *the
  user is the spec* — the REST twin of how CLI works today. junction ships nothing
  app-specific, so an upstream change breaks nothing in junction.

junction is always the **execution** layer and **never guesses** an API's shape —
it knows tools only because it was told or can deterministically fetch them.

The `/app/:id` page becomes the **capability surface** for a service: which
surfaces are connected, what each exposes, and the toolset an agent actually
receives. junction's **own App catalog** (shipped declarative data — *not* a
runtime plugin loader) is an *optional auto-fill layer* over junction's existing
base (platforms/credentials/profiles): it pre-fills setup for known apps; manual
setup (which already exists) is always the fallback. The catalog is **drafted by a
dev-time importer that reads integrations.sh** (a research input, never a runtime
dependency), then human/AI-verified and committed; **verify-on-add** tests every
connection against the real upstream. junction never depends on the catalog — or
on integrations.sh — to function.

**The load-bearing reframe:** junction is a deterministic broker with **no LLM
inside it**. It does not "figure out" APIs. Every surface's knowledge comes from
the *provider's own self-description* (help text, OpenAPI spec, introspection),
fetched live or supplied once — never invented by junction.

---

## 1. Why (the problems this solves)

Three problems surfaced in the current model (`provider-concept.md` shipped the
App as a *derived grouping* of connections; this extends it):

1. **OAuth was shown as if it were a way to "connect."** It isn't — an OAuth token
   with no surface consuming it gives an agent **zero tools**. The app page showed
   "Connect via OAuth" as a vertical, which is a dead end. (Concretely: Google
   ships `oauth2` + `supportedKinds:["openapi"]` but **no ready surface** — the
   token has nowhere to go. See `catalog.ts` Google entry.)

2. **A service is often reachable *several* ways, and they're better together.**
   GitHub is an MCP server *and* a REST API *and* a GraphQL API *and* the `gh` CLI.
   A user may want more than one connected — the rich named tools from MCP for the
   common path, plus the CLI escape hatch for whatever MCP doesn't cover.

3. **Per-endpoint / per-command curation doesn't scale.** Hand-maintaining a tool
   per REST endpoint or per `gh` subcommand is a treadmill — APIs and CLIs change.
   junction should lean on the provider's own self-description, not re-curate it.

---

## 2. Core concepts

### 2.1 App (unchanged from inc 30, extended)

An App is a real service. It stays **derived** at read-time (no new persistent
entity) — `appIdForConnection` (`core/apps/group.ts`) attributes a
platform+credential to an app. This doc **adds** the surface dimension on top.

### 2.2 Surface (new first-class concept in the UI/model vocabulary)

A **surface** = one way junction reaches an app = one `Platform.kind` + its
connection config. Today's `PlatformKind` is `mcp | openapi | graphql | cli`.
This doc **adds one kind: `http`** (a REST API whose tools are user-authored) and
records **`grpc`** as a candidate surface to research (§2.6).

The right axis is **who authors the tool definitions** — junction is always the
*execution* layer; the difference is where the *knowledge* (named, typed tools)
comes from:

| Surface | Kind | Tools authored by | Agent gets |
|---|---|---|---|
| MCP | `mcp` | the upstream server | the server's own named tools (`listTools()`) |
| OpenAPI | `openapi` | **junction, from a spec** | one named, typed tool per operation |
| GraphQL | `graphql` | the schema (introspection) | `graphql_query`/`_mutation`/`_schema` |
| **HTTP** | **`http`** *(new)* | **the USER, by hand** | user-defined named, typed request-tools |
| CLI | `cli` | the operator, by hand | operator-defined command-tools |
| gRPC? | `grpc` *(candidate)* | a `.proto` / reflection | (research — §2.6) |

**The key realization (resolves the earlier "OpenAPI vs HTTP" confusion):**
OpenAPI and HTTP produce the **same thing** — named, typed, parameter-bound
tools. The *only* difference is the authoring path: **OpenAPI generates the tool
definitions from a spec; HTTP has the user author them by hand.** For HTTP,
**the user IS the spec.** So HTTP is not an "execution-only escape hatch" (which
would be execution without knowledge — genuinely confusing for an agent); it is
the REST twin of the existing **CLI** model (operator declares each tool).

junction **never guesses** an API's shape. It knows a surface's tools only
because it was *told* (a spec URL / user-authored definitions / an MCP server that
lists them) or can *deterministically fetch* them (GraphQL introspection). There
is no LLM in junction; when nothing is available, junction honestly has no tools —
it does not invent them.

### 2.3 The HTTP surface — what the user defines (decided 2026-07-05)

An `http` surface = a **connection** (set once) + a set of **user-authored
request-tools** (the REST twin of a CLI connection's command-tools).

**Connection (once):**
- **Base URL** (required) · **Auth** (required unless the API is public — a normal
  junction Credential) · **Default headers** (optional, applied to every call).

**Per request-tool (the user defines each; "lean required + rich optional"):**
- **Required:** `name` · `description` (this IS the knowledge — when to use it) ·
  `method` · `path` (with `{placeholders}`) · **params, each with a LOCATION**
  (`path` | `query` | `header` | `body`) + type + required-ness.
- **Optional:** per-param descriptions/enums · example call/response · response
  hint · timeout · confirm-on-write.

**Parameter binding is the load-bearing detail:** each param declares *where it
goes* in the request (path placeholder / query string / header / body field) —
exactly what an OpenAPI operation encodes automatically, and what junction's
OpenAPI client already extracts + what CLI argv-slots already model. So the
machinery pattern exists; HTTP is a new *authoring surface* over a known shape.

**Safety (junction is the execution layer):** by defining tools, the user *is*
the allowlist — the agent can only call defined tools, not arbitrary paths.
(An optional raw `request(method,path,body)` escape-hatch tool MAY be offered as
one such tool, but the norm is defined, typed tools — not bare execute.)

### 2.4 The generic CLI surface (the maintenance answer for CLIs)

CLI stays operator-declared per today, but the *agent-facing* model becomes
app-agnostic primitives so junction ships zero app-specific CLI knowledge:
`cli_help` (recursive `--help`), `cli_search`, `cli_describe`, `cli_execute` (run
an allow-listed command, sandboxed) — the **same tools for `gh`, `aws`,
`kubectl`, `stripe`**. *(Exact rework scoped at the CLI increment; the point here
is CLI + HTTP are both user/operator-authored surfaces, not junction-curated.)*

### 2.5 Auth is a property OF a surface, not a surface

Every surface authenticates somehow (OAuth token, PAT, API key, none). The app
page shows auth as an attribute of each surface connection ("REST — authed via
your GitHub OAuth"), and flags **auth with no consuming surface** as a gap
("connected, but no surface uses it → add a surface"). If *no* surface can consume
an auth, that's junction telling you a **surface type is missing**.

### 2.6 gRPC — candidate surface (research, not decided)

gRPC services describe themselves via `.proto` files and often support **server
reflection** — so gRPC could be a **schema-backed** surface (auto-generated tools,
like OpenAPI), not a hand-authored one. Open questions before committing:
does junction's stack have a viable Node gRPC client story? reflection vs.
user-supplied `.proto`? streaming semantics as "tools"? **Recorded as a candidate
to research at/after the HTTP surface increment — not in the committed set.** (§9)

---

## 3. The served toolset (how surfaces become what the agent sees)

### 3.1 Today (verified by code audit, 2026-07-05)

junction does **NOT** compose surfaces. The agent-facing toolset is a **flat
concatenation** of each `source_ref`'s tools, prefixed by that source's own
`toolNamespace` (`core/sources/proxy.ts` → `namespaceToolName`). There is **no**
cross-surface merge, **no** dedup, **no** precedence, and **no** stable
cross-surface capability identity (`create_issue` from MCP is an independent
string from `issues_create` from REST). Composition happens at the **Profile**
layer; "App" has **zero presence** in the serving path.

### 3.2 This design — v1: honest namespace-per-surface (NO semantic dedup)

Because no capability identity exists, v1 does **not** invent one. Each connected
surface for an app contributes its tools under its **own namespace**:

```
github_mcp__create_issue        (server-authored, named)
github_mcp__search_repositories
github_openapi__issues_create   (spec-generated, named)
github_graphql__graphql_query   (introspection-backed)
github_cli__cli_execute         (operator-authored, app-agnostic primitives)
tickets_http__create_ticket     (USER-authored typed request-tool)
```

The agent sees them all under their own per-surface namespace. Every surface
yields **named, typed tools** — differing only in who authored them (server /
spec / user). This is honest to what junction can build today and requires **no
new capability-identity abstraction** (that's the deferred §3.3 work).

### 3.3 Deferred — semantic composition (dedup + precedence + fallback)

The richer "one `github__` namespace, deduped across surfaces, CLI silently fills
MCP's gaps" model is **explicitly deferred**. It requires a **stable
cross-surface capability identity** (a canonical capability map) that does not
exist and is genuinely hard (each surface names things independently). Recorded as
a future direction with its trigger (§9). v1's namespace-per-surface is the
honest, shippable floor; composition is an enhancement on top, not a prerequisite.

---

## 4. The App catalog — junction's OWN declarative data, seeded by an importer

junction already has the durable base: platforms, credentials, profiles, the
vault, the four (soon five) surfaces, and **manual setup flows for all of them**.
The **App catalog** is junction's own, shipped-in-core, **declarative data** that
**auto-fills** what an operator would otherwise type by hand — a known app's
surfaces, spec URL, OAuth config, MCP server URL, auth header/scheme, default
scopes, setup hints — writing into the **same** `Platform`+`Credential` rows the
manual path creates. It **extends** inc-30's App catalog (which had `id`,
`displayName`, `supportedKinds`, `auth`, `aliases`, `iconSlug`) with **per-surface
setup data**.

### 4.1 What it is — and is NOT (decided with the user, 2026-07-05)

- **It IS declarative catalog DATA** — app definitions shipped inside junction
  core (e.g. `packages/core/src/apps/catalog/github.ts`), the same *kind* of data
  as inc-30's `AppDefinition`, extended with surface setup. junction owns it.
- **It is NOT a runtime plugin loader / executable code.** No dynamic loading, no
  third-party code execution — consistent with CLAUDE.md's explicit decision to
  *not* build a plugin loader, and with the App staying derived/declarative.
  *(Loadable/community-contributed app packs are a possible FUTURE using the SAME
  declarative format — recorded in §9, not built now.)*
- **junction has no LLM / no discovery at runtime.** The catalog is static data
  junction maps onto its existing setup flows.
- **Never load-bearing.** Unknown app, stale entry, or no catalog → the operator
  uses the manual setup that already ships. junction never breaks.

### 4.2 How the catalog gets built — the integrations.sh importer (dev-time only)

The catalog is **partially maintained**: junction owns the final data, but a
**dev-time importer** drafts entries fast so authoring isn't from-scratch.

**integrations.sh is a DEV-TIME RESEARCH INPUT, never a runtime dependency.** The
importer (a build/authoring script, off the product's runtime path) does:

```
GET https://integrations.sh/api/{domain}/surface   ← ONE deterministic cached read
   ↓ importer maps the payload → a DRAFT AppDefinition (fields tagged unverified)
   ↓ HUMAN + AI review: confirm/correct, add what's missing, check auth
commit → packages/core/src/apps/catalog/   ← junction's own shipped data
```

Key properties (all verified against the live API, 2026-07-05):

- **The `/api/{domain}/surface` endpoint is a deterministic KV read** — byte-
  identical on repeat calls, does **not** trigger their LLM. (`/discover` does; the
  importer uses `/surface`, not `/discover`.) So the importer is reproducible.
- **The payload's credential/auth schema maps ~1:1 onto junction's model** —
  named credential defs (`type`, `generateUrl`, human `setup` prose) + per-surface
  `auth.mechanics` (`in:header`, `headerName`, `scheme:"Bearer"`). This is the
  strongest part and the reason it's worth using.
- **The data is LLM-authored (`usedLlm:true`), mostly `via:"discovered"`
  (guessed), occasionally `via:"detected"` (machine-verified, e.g. a live
  `mcp:initialize`).** So it is a **high-quality DRAFT, never trusted truth.**
- **If integrations.sh vanishes, nothing junction ships is affected** — the drafts
  are already snapshotted into junction's own catalog.

### 4.3 The review gate + the safety net (why guessed data is safe here)

- **Human/AI review is MANDATORY, guided by the `detected`/`discovered` tag** —
  auto-accept `detected` facts; scrutinize `discovered` ones. Review is *confirm +
  fill gaps*, not *rebuild* (see §4.4).
- **junction's own verify-on-add (inc 28.9) is the final net.** A catalog entry
  only ever *pre-fills* a setup form the user confirms; junction then **empirically
  tests the credential against the real upstream before saving.** A wrong guess
  fails the test → caught, never committed as a working-looking-but-broken
  connection. Guessed data can never become trusted config without an empirical
  check.

### 4.4 Empirical validation — the importer works (tested on 2 real apps)

Ran the importer flow against real `/surface` payloads:

| App | Facts correct | Wrong | `detected` (verified) | Human adds/notes |
|---|---|---|---|---|
| **GitHub** | 7 / 9 | **0** | 0 | spec URL; MCP surface (omissions) |
| **Stripe** | 8 / 10 | **0** | 1 (MCP server) | spec URL; test-vs-live-mode note |

**Net: 15/19 correct, 0 wrong, 4 human-adds** — the human pass *confirmed and
filled gaps*, it did **not correct errors**. Stripe even captured a subtle
`Stripe-Account` (Connect) header. So the "partial maintenance" is genuinely
**light**. **Caveat (do not over-generalize):** both apps are very
well-documented; an obscure app will guess worse — the human gate + verify-on-add
stay mandatory, not optional.

### 4.5 Other data sources (secondary / for specific fields)

- **apis.guru (CC0, ~2,529 APIs)** — clean, maintenance-free source specifically
  for the **OpenAPI spec URL** the importer's payload omits (it gives docs, not the
  spec). AGPL-safe.
- **Nango `providers.yaml`** — richest OAuth-mechanics reference, BUT **Elastic
  License 2.0** ("no competing hosted service") → **schema reference only**, do NOT
  vendor into AGPL. (Resolve at the importer increment.)
- **MCP registry `server.json` schema** — align junction's MCP-surface metadata to
  this emerging open standard.

**Net:** the catalog = **junction's own shipped declarative data**, drafted by an
**integrations.sh importer** (dev-time), topped up from apis.guru (spec URLs),
human+AI verified, with **verify-on-add** as the runtime safety net. An *optional
accelerator* over the manual base — nothing here is load-bearing.

---

## 5. What exists today vs. what's net-new (honest capability audit)

From a direct code audit (four agents, 2026-07-05):

| Piece | State | Evidence / gap |
|---|---|---|
| App as derived grouping | **exists** | `core/apps/group.ts appIdForConnection` |
| MCP / OpenAPI / GraphQL / CLI surfaces | **exist** | `PlatformKindSchema`, per-kind connection schemas + providers |
| CLI = generic primitives | **partial → needs rework** | today CLI = "one operator-declared command = one tool" (`core/sources/cli/provider.ts`). The **generic execute+help+search+describe** model is net-new. |
| HTTP surface (`http`) | **absent** | no `http` kind; a spec-less REST API with user-authored tools is unreachable today. Machinery pattern exists (OpenAPI param-binding + CLI tool-authoring) |
| gRPC surface (`grpc`) | **candidate** | not designed; research whether a Node gRPC + reflection story fits (§2.6) |
| Show tools on the app page | **absent** | app pages show connections, never tools. The inc-28 **probe** lists a *profile route's* tools (`web/src/server/probe.server.ts`) — reusable, but profile-scoped, and it drops `inputSchema` today |
| Multi-surface-per-app grouping | **partial** | two platforms for one app only co-group if each satisfies an exact attribution rule; the `<appId>-<kind>` structured-suffix rule is **planned, not built** (only in `docs/methods/30.5-app-lifecycle.md`) |
| One credential → many surfaces | **absent** | `credential.platformId` is a single FK; sharing one OAuth token across a `github-mcp` and `github-http` platform needs duplicated credentials or a new model |
| Cross-surface capability identity / dedup / precedence | **absent** | nothing maps tool names across surfaces; serving path is prefix+concatenate only |
| Catalog auto-fill | **absent** | `supportedKinds` is a *capability hint*, not wiring; no spec URLs / one-click connect |

---

## 6. Load-bearing decisions (settled here; the rest deferred)

**Settled with the user (2026-07-05):**
1. **Surface-first app page** — organize `/app/:id` by surface; auth is a property.
2. **Two families** — schema-backed (named tools) vs generic (primitives).
3. **Generic CLI** — app-agnostic `execute/help/search/describe`; drop per-command
   curation. Solves the maintenance treadmill.
4. **HTTP is a distinct new surface** (`http`) alongside OpenAPI — for a REST API
   with no spec, where **the user hand-authors typed request-tools** (the REST twin
   of CLI). Not a bare execute escape-hatch. "Lean required + rich optional" fields
   (§2.3).
5. **OpenAPI vs HTTP = same tool shape, two authoring paths** (spec-generated vs
   user-authored) — two surfaces, chosen by whether a spec exists to generate from.
   **gRPC** recorded as a research candidate (§2.6), not committed.
6. **v1 = namespace-per-surface, NO semantic dedup** — honest to today's code;
   composition deferred.
7. **Catalog = junction's OWN declarative data** (not a runtime plugin loader),
   an optional auto-fill over the existing base, never a dependency; feeds the
   same platform/credential rows manual setup creates.
8. **Catalog is drafted by a dev-time integrations.sh importer** → human/AI review
   (detected/discovered-guided) → committed as junction-owned data;
   **verify-on-add is the runtime safety net.** integrations.sh is never touched at
   runtime. Validated on GitHub + Stripe (15/19 facts correct, 0 wrong).
9. **First increment = the read-only surface-first app page** (no backend change).

**Deferred to their own decisions (with triggers in §9):**
- Semantic composition (dedup/precedence/fallback) + a capability-identity model.
- One-credential-many-surfaces (shared OAuth token across surfaces of one app).
- **Dynamic / community-loadable app packs** (the SAME declarative format loaded at
  runtime from a user dir) — the "plugin" extension deliberately NOT built now.
- apis.guru for spec-URL top-up + the **Nango Elastic-License-2.0 review** —
  finalize at the importer increment.
- Whether OpenAPI + HTTP eventually collapse into one auto-fidelity surface.
- **gRPC as a (schema-backed) surface** — research the Node client + reflection
  story (§2.6).

---

## 7. UX shape (from the mockup)

`/app/github`:
1. **Header** — app glyph + name + "N surfaces connected".
2. **Surfaces** — a card per surface: family (schema/generic), state (serving /
   paused / not set up), auth chip ("via OAuth · github"), tool count, and an
   expandable tool list. Connected surfaces toggle on/off; unconnected offer
   "+ Add <surface>" (catalog-prefilled when known, else manual).
3. **Toolset your agents receive** — the served set (v1: `github_<surface>__tool`
   rows, tagged by surface + family), recomputed live as surfaces/tools toggle.
4. **Authentication** — each auth + the surface(s) consuming it; the "auth with no
   surface" gap called out honestly.

The page is a **window onto the existing base** — reading platforms/credentials/
profiles + (increment 1) the probe surface for tool lists. No new persistence for
the first increment.

---

## 8. Incremental build order (each its own method file + gates)

The **whole vision** is above; it ships in slices, smallest-visible-value-first.

1. **App page: surfaces + tools (read-only).** Rebuild `/app/:id` surface-first;
   list each connected surface's tools by reusing the inc-28 probe (extend it to
   surface an `inputSchema` summary + be app-scoped, not only profile-scoped).
   **No schema/backend change** — pure read/display layer. Proves the model.
   *(FIRST — user choice.)*
2. **HTTP surface (`http`).** New `PlatformKind: "http"` + `HttpConnection` schema
   (base URL + auth + default headers) + **user-authored request-tools** (name,
   method, path, params-with-location, description; optional enums/examples/
   response-hint/timeout/confirm) + a `createHttpProvider` (authed, sandboxed).
   The REST twin of the CLI connection; reuses the OpenAPI client's param-binding
   pattern. Fills the spec-less-REST gap. *(Consider a raw request() escape-hatch
   tool as optional.)* Backend-heavy; the app page (inc 1) then shows it.
3. **App catalog + importer.** Build the **dev-time integrations.sh importer**
   (`/api/{domain}/surface` → draft AppDefinition → human/AI review → commit) and
   the extended per-surface catalog schema; wire one-click "Connect <app>
   <surface>" that pre-fills the existing platform+credential setup, gated by
   verify-on-add. Optional-accelerator semantics (§4). *(Do apis.guru spec-URL
   top-up + the Nango license review here.)*
4. **Multi-surface connect / change-method / composition groundwork.** Connecting
   a second surface for the same app cleanly (the `<appId>-<kind>` groupability
   rule from `30.5-app-lifecycle.md`, now in service of *accumulation* not
   *swap*); re-frame "Change method" as *add a surface* rather than replace.
5. *(Deferred, gated):* semantic composition — one namespace, dedup, precedence,
   CLI-fills-gaps — once a capability-identity approach is chosen (§9).

Also: the CLI generic-primitives rework (from per-command tools) slots where it
best serves the above — likely alongside or just after inc 1, since it changes
what the CLI surface *shows* on the app page.

---

## 9. Forward register (record at build — `docs/futures/`)

- **`revisit-when.md`:** *Semantic composition across surfaces* — one `github__`
  namespace with dedup + precedence + CLI/HTTP gap-fill. **Trigger:** a chosen,
  low-false-positive **cross-surface capability identity** (canonical capability
  map) exists, AND users are actually connecting ≥2 surfaces per app and want a
  single merged namespace. Until then: namespace-per-surface (honest, no
  mis-dedup). *Blocked-by:* no capability identity today (audit-confirmed).
- **`revisit-when.md`:** *One credential → many surfaces* (share an OAuth token
  across an app's `mcp` + `http` platforms). **Trigger:** users connect multiple
  authed surfaces for one app and re-vaulting the token per surface becomes real
  friction. *Blocked-by:* `credential.platformId` single FK.
- **`revisit-when.md`:** *Collapse OpenAPI + HTTP into one auto-fidelity surface.*
  **Trigger:** the two-card UX proves redundant / confusing in real use (they're
  already the same tool shape, two authoring paths).
- **`revisit-when.md`:** *gRPC surface.* **Trigger:** a real need for a gRPC
  service + a viable Node gRPC + reflection/`.proto` story (§2.6). Likely
  schema-backed (auto-authored), not hand-authored.
- **`revisit-when.md`:** *Dynamic / community-loadable app packs* — load the SAME
  declarative catalog format at runtime from a user dir / community registry
  (the "plugin loader" deliberately NOT built now). **Trigger:** real demand for
  apps beyond junction's shipped catalog + a format/validation/trust design for
  third-party definitions. Until then: catalog is shipped-in-core data only.
- **`revisit-when.md`:** *Catalog data sources (secondary)* — apis.guru (CC0) for
  the OpenAPI **spec URL** the importer payload omits; Nango `providers.yaml` =
  **reference schema only** pending an **Elastic-License-2.0 vs AGPL review** (the
  real open legal question — do NOT vendor the file until cleared). **Trigger to
  finalize:** the importer increment (inc 3) starts.
- **`gotchas.md`:** the integrations.sh importer payload is **LLM-authored
  (`usedLlm:true`), mostly `via:"discovered"` (guessed)** — a high-quality DRAFT,
  NEVER trusted truth. Use `/api/{domain}/surface` (deterministic cached read), NOT
  `/discover` (fires their LLM). Human review + verify-on-add are mandatory; both
  test apps (GitHub/Stripe) were well-documented and guessed well — obscure apps
  will guess worse.
- **`gotchas.md`:** the app page's tool list reuses the inc-28 **probe**, which is
  **profile-scoped and drops `inputSchema`** — inc 1 must extend it (app-scoped +
  schema summary) rather than assume it's ready.
- **`deprecations.md`:** integrations.sh is a **dev-time importer input only** (not
  a runtime/shipped dependency) — but it's a 2-month-old solo repo with no content
  hash. Track its health; if it dies, the importer loses a drafting shortcut but
  junction's shipped catalog is unaffected. Snapshot `_provenance` (source +
  `discoveredAt`) on each imported entry so a re-import is diffable.
