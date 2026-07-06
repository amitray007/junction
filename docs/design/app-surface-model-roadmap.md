# App Surface Model — build roadmap (increment sequence)

> **Companion to** `docs/design/app-surface-model.md` (the design). This is the
> **sequencing plan**: which increments deliver the vision, in what order, with
> dependencies + rough scope + gates. Planning only — each increment gets its own
> **method file** (`docs/methods/NN-*.md`) before it's built, per the operating
> model. Written 2026-07-06.

---

## 0. Where we are

The App Surface Model ships incrementally. Progress against the design:

- ✅ **inc 30 — App concept** (derived grouping, `/app` surface, AppCatalog v1). Done.
- ✅ **inc 30.7 — HTTP surface** (`http` kind, user-authored request-tools). Done (PR #104).
  This was the "first implementation slice" and it reframed inc-30.5's "Change
  method" as *add a surface* (the Slice-3 swap is deferred, not built).
- ⬜ **The catalog + the surface-first App page + multi-surface connect** — remaining.

The surface *primitives* now largely exist (mcp/openapi/graphql/cli/http). What's
missing is: (a) junction's **own rich per-app catalog** that drives one-click
connect + the page, (b) the **surface-first `/app/:id`** that shows surfaces +
their tools, and (c) **connecting multiple surfaces per app** cleanly.

---

## 1. The sequence (proposed)

Numbered as **30.x sub-increments** (consistent with 30.5/30.7), landing before
**31 — Audit**. Each is one method file, one review gate, one user-test gate.

| # | Increment | Depends on | Rough scope | Backend? |
|---|---|---|---|---|
| **30.8** | **App catalog schema + one hand-authored app** | 30.7 | The catalog *shape* proven on ONE real app end-to-end | core (data) + web (render) |
| **30.9** | **integrations.sh importer (dev-time)** | 30.8 | The authoring accelerator (integrations.sh → draft); REST defaults to `http` | dev tooling only |
| **30.9.5** | **apis.guru spec-URL top-up + Nango license review** | 30.9 | Upgrade importer `http` surfaces → `openapi` via apis.guru (CC0); Nango Elastic-2.0-vs-AGPL gate | dev tooling only |
| **30.10** | **Surface-first `/app/:id` page** | 30.8 | Render surfaces + tools + catalog details; empty honest | web (read/display) |
| **30.11** | **Catalog-driven one-click connect** | 30.8, 30.10 | Build recipe → Platform+Credential, verify-on-add gate | web + orchestration |
| **30.12** | **Multi-surface connect / add-a-surface** | 30.11 | `<appId>-<kind>` grouping; "add a surface" (ex-"change method") | core + web |
| *(later)* | **CLI generic-primitives rework** | — | `cli_help/search/execute/describe` (changes CLI's page display) | core + source-runtime |
| *(deferred)* | **Semantic composition** | capability-identity | one namespace, dedup, precedence — gated (§3.3 of design) | core |
| *(candidate)* | **gRPC surface** | — | research Node gRPC + reflection (§2.6 of design) | core |

**Why this order** (smallest-blocking-core-first, each independently valuable):

1. **30.8 first proves the schema on real data** before we build tooling around it.
   Author ONE app (GitHub) by hand into the `catalog.json`/`help.json`/`tools/`
   structure (§4.6), and render it on the App page minimally. This de-risks the
   schema — we find out what fields we actually need by using them, before the
   importer or the full page depend on the shape. **No importer yet** (hand-author).
2. **30.9 (importer)** only after the schema is proven — the importer *targets* the
   schema, so the schema must be stable first. It's dev-time tooling (off the
   runtime path), lowest product risk.
3. **30.10 (the page)** is a pure read/display layer over the catalog + the inc-28
   probe (for a connected surface's *actual* tools). No new persistence. High
   visible value; proves the surface-first model.
4. **30.11 (one-click connect)** is where the **build recipe** executes → normal
   `addPlatform`/`addCredential` + verify-on-add. This is the first place the
   catalog *writes* — so it lands after the read-only page is solid.
5. **30.12 (multi-surface)** delivers the reframed "change method → add a surface"
   + the `<appId>-<kind>` groupability rule (already scoped in `30.5-app-lifecycle.md`).

---

## 2. Per-increment sketch (what each method file will cover)

### 30.8 — App catalog schema + one hand-authored app
- **Core:** the catalog schema (Zod) — `catalog.json` (identity, surfaces[],
  connection templates targeting existing `Platform` kinds, auth, build recipe,
  verify) + `help.json` (install/authSetup/docs/agentGuidance) + `tools/` (starter
  request-tools). Folder-per-app loader (`packages/core/src/apps/catalog/`).
  **Core + durable-rich tiers only** (§4.6); rot-prone fields optional/flagged.
- **Proof:** hand-author **GitHub** fully (all 5 surfaces; HTTP empty per gap-filler
  rule §4.7); a test asserts it loads + validates + maps to the existing
  `AppDefinition` shape (inc-30 back-compat — no regression to `groupByApp`).
- **Decisions to lock at method-file time:** JSON vs YAML (recommend JSON —
  Zod-validates trivially, no new dep); exact `build` recipe shape.
- **Reviewers:** `junction-package-boundary` (core purity — catalog is data, no
  HTTP/web leak), `junction-clean-code`, `ce-correctness`.

### 30.9 — integrations.sh importer (dev-time)
- **Tooling:** a script (`packages/core/scripts/` or a dev workspace) that reads
  `GET integrations.sh/api/{domain}/surface` → drafts a catalog entry (fields
  tagged `detected`/`discovered`) → writes a draft for human review. Off the
  runtime path; never shipped/imported at runtime.
- **apis.guru top-up + Nango license review → split to inc 30.9.5** (orchestrator
  decision 2026-07-06 — keeps 30.9 focused on the integrations.sh→draft mapping;
  spec-URL enrichment + the Nango legal gate are a separate follow-up). 30.9 defaults
  a REST surface to `http` and never fabricates a specUrl.
- **Proof:** re-derive the GitHub + Stripe drafts (matches the 2026-07-05 worked
  examples: 15/19 facts correct, 0 wrong); the human-review gate is documented.
- **Reviewers:** `junction-package-boundary` (no runtime dep on integrations.sh),
  `ce-maintainability` (the generator), `ce-security` (no LLM-guessed data auto-committed).

### 30.10 — Surface-first `/app/:id` page (read-only)
- **Web:** rebuild `/app/:id` to render **from the catalog** (surfaces, auth chips,
  install/docs/guidance) + the **inc-28 probe** for a connected surface's actual
  tools (extend probe: app-scoped + surface an `inputSchema` summary — currently
  profile-scoped + drops inputSchema, see design §5). All surfaces shown equally;
  **empty surfaces shown honestly** ("no tools available"). Pure read/display.
- **Proof:** real-server QA (junction-web-verify + agent-browser) — GitHub page
  shows 5 surfaces, HTTP honestly empty, tools listed per connected surface, both
  themes. No secret leak (metadata-only at the web edge).
- **Reviewers:** `junction-web-reviewer`, `ce-correctness`.

### 30.11 — Catalog-driven one-click connect
- **Web + orchestration:** "Connect <app> <surface>" reads the catalog's **build
  recipe** → pre-fills the setup form → on submit runs the **normal validated**
  `addPlatform`/`addCredential` (via `@junction/platform-orchestration`) → gated by
  **verify-on-add** (inc 28.9). Catalog data NEVER silently committed; the user
  confirms; verify tests it against the real upstream before saving.
- **Starter tools** for user-authored surfaces (HTTP/CLI) pre-populate on connect.
- **Proof:** real connect of a catalog app end-to-end; a wrong catalog guess fails
  verify (not a false-green connection). Secret swept clean.
- **Reviewers:** `junction-credential-security`, `junction-web-reviewer`, `ce-correctness`.

### 30.12 — Multi-surface connect / add-a-surface
- **Core + web:** connect a SECOND surface for the same app without collision — the
  `<appId>-<kind>` platform-id + the groupability rule (from `30.5-app-lifecycle.md`
  §5, now serving *accumulation* not *swap*). Re-frame the ⋯ "Change method" as
  **"Add a surface."** (The original reconnect-first *swap* stays deferred unless a
  real need appears — the design supersedes it.)
- **Reviewers:** `junction-credential-security`, `junction-web-reviewer`, `ce-correctness`.

---

## 3. What stays deferred (with triggers — mirror design §9)

- **Semantic composition** (one merged namespace, dedup, precedence, CLI/HTTP
  gap-fill) — needs a cross-surface capability identity (doesn't exist; hard).
  Trigger: a low-false-positive identity approach + real user demand for one merged
  namespace.
- **CLI generic-primitives rework** — slot when it best serves the page (it changes
  what CLI shows). Not blocking the catalog/page.
- **gRPC surface** — research candidate (design §2.6).
- **Dynamic/community-loadable app packs** — the "plugin loader" extension; NOT now.
- **One credential → many surfaces** — shared OAuth token across an app's surfaces;
  blocked by the single-FK `credential.platformId`.

---

## 4. Open sequencing questions (resolve with the user before 30.8's method file)

1. **30.8 vs 30.10 order / merge?** 30.8 (schema+one app) and 30.10 (the page) could
   merge into one increment ("author GitHub + show it"), since a schema with no
   renderer is hard to validate. Recommend: **keep 30.8 lean (schema + load test +
   the data)**, then 30.10 renders — but a combined "catalog+page for GitHub" is a
   reasonable single increment if we want a visible result sooner.
2. **Numbering** — 30.8+ vs. rolling into a fresh top-level number. 30.x keeps the
   "App Surface Model" increments grouped (like 30.5/30.7); fine unless the user
   prefers a clean 31 = App-catalog and pushing Audit to 32.
3. **Does inc-30.5's remaining scope** (Test-Connection auto-refresh bug, per-app
   icons) still need landing independently, or is it absorbed/obsolete? Check status
   before starting 30.8 (30.5 is still "planned" in the map).
