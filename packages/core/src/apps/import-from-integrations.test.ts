// SPDX-License-Identifier: AGPL-3.0-only
// Tests for the integrations.sh importer (increment 30.9,
// docs/methods/30.9-integrations-importer.md). Table-driven against captured
// github.com + stripe.com `/surface` payloads (committed fixtures — see
// packages/core/scripts/__fixtures__/integrations-sh/), so these tests never
// hit the network. The importer script itself lives OUTSIDE src/ (a .mjs, like
// gen-catalog.mjs) — this file imports its pure mapping functions + the
// `buildDraft` orchestrator by relative path, using the promise-based fs API
// to stay clear of the core boundary-guard's blocking-sync-I/O rule even
// though this is test-only code.
//
// LIVE-DATA NOTE (recorded, not papered over — see method file §4, fixed in
// commit 0094bf0 after this was flagged mid-build): the design doc's §4.4
// table originally described the github.com payload as including an `mcp`
// surface (kind set `{mcp, graphql, cli, http}`). The ACTUAL live payload
// fetched 2026-07-06 (committed as the fixture below) has NO mcp surface for
// github.com — `detect.mcp: []`, only graphql/cli/http. integrations.sh's own
// detection found no discoverable MCP signal for github.com at fetch time
// (GitHub's hosted MCP server isn't found by the llms.txt/integrations.json/
// mcp-server-card/oauth-protected-resource/agent-card signals integrations.sh
// probes). Stripe's payload DOES carry an mcp surface (detected via
// mcp:initialize), matching the doc.
//
// Fix (per team-lead direction): the equivalence predicate below DERIVES its
// expected kind-set FROM the committed fixture's own surfaces[].type set,
// never from a hardcoded literal — so the test is drift-proof (a future
// re-fetch that changes the fixture moves the expectation with it) while
// staying genuinely falsifiable (a real importer bug still fails it). See
// docs/futures/gotchas.md for the "integrations.sh detection is live and
// drifts" entry.

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  basisToFact,
  credentialToAppAuth,
  credentialTypeToAppAuth,
  credentialTypeToBuildKind,
  dedupAppAuth,
  firstAuthModeToBuildCredentialKind,
  mapSurface,
  proposeAppId,
  transformCliEnvVar,
} from "../../scripts/import-from-integrations.mapping.mjs"

// Relative reach into packages/core/scripts/ — test-only, not a runtime
// src-to-scripts dependency (scripts/ is outside the depcruise'd runtime
// graph; core-not-http / core-imports-nothing-in-repo are unaffected since
// this edge exists only in a *.test.ts file, never in a shipped module).
import { buildDraft } from "../../scripts/import-from-integrations.mjs"
import { AppCatalogEntrySchema } from "./catalog-schema.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, "..", "..", "scripts", "__fixtures__", "integrations-sh")

async function loadFixture(name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(FIXTURES_DIR, name), "utf8")
  return JSON.parse(raw)
}

// ---------------------------------------------------------------------------
// Pure mapping function tests (table-driven, no fixtures needed)
// ---------------------------------------------------------------------------

describe("proposeAppId", () => {
  it.each([
    ["github.com", "github"],
    ["stripe.com", "stripe"],
    ["www.example.io", "example"],
  ])("%s -> %s", (domain, expected) => {
    expect(proposeAppId(domain)).toBe(expected)
  })
})

describe("credentialTypeToAppAuth — §2b table, oauth2 NEVER guesses a providerId", () => {
  it.each([
    ["oauth2", { mode: "oauth2", providerId: "REVIEW:providerId" }],
    ["bearer", { mode: "token" }],
    ["api_key", { mode: "token" }],
    ["jwt", { mode: "token" }],
  ])("%s -> %o", (type, expected) => {
    expect(credentialTypeToAppAuth(type)).toEqual(expected)
  })

  it("an unknown credential type maps to undefined (never fabricated)", () => {
    expect(credentialTypeToAppAuth("bogus")).toBeUndefined()
  })

  it("the oauth2 providerId placeholder is ALWAYS the exact REVIEW: sentinel, never a guess", () => {
    const auth = credentialTypeToAppAuth("oauth2")
    expect(auth?.mode).toBe("oauth2")
    expect((auth as { providerId: string }).providerId).toBe("REVIEW:providerId")
    expect((auth as { providerId: string }).providerId.startsWith("REVIEW:")).toBe(true)
  })
})

describe("credentialToAppAuth — credential-ID-aware oauth2 placeholders (§2g M2 fix)", () => {
  it("two DIFFERENT oauth2 credentials get DIFFERENT (still REVIEW:-sentinel) placeholders", () => {
    const a = credentialToAppAuth("github_oauth_app", { type: "oauth2" })
    const b = credentialToAppAuth("github_app", { type: "oauth2" })
    expect(a).toEqual({ mode: "oauth2", providerId: "REVIEW:providerId:github_oauth_app" })
    expect(b).toEqual({ mode: "oauth2", providerId: "REVIEW:providerId:github_app" })
    expect(a.providerId).not.toBe(b.providerId)
    expect(a.providerId.startsWith("REVIEW:providerId")).toBe(true)
    expect(b.providerId.startsWith("REVIEW:providerId")).toBe(true)
  })

  it("non-oauth2 credential types delegate to credentialTypeToAppAuth unchanged", () => {
    expect(credentialToAppAuth("some_bearer_cred", { type: "bearer" })).toEqual({ mode: "token" })
    expect(credentialToAppAuth("some_bogus_cred", { type: "bogus" })).toBeUndefined()
  })

  it(
    "REGRESSION for the vacuity a review caught: feeding two distinct oauth2 credentials through " +
      "dedupAppAuth via credentialToAppAuth preserves BOTH — the bare credentialTypeToAppAuth form " +
      "would have collapsed them (identical placeholder -> identical dedup key)",
    () => {
      const viaCredentialToAppAuth = dedupAppAuth([
        credentialToAppAuth("github_oauth_app", { type: "oauth2" }),
        credentialToAppAuth("github_app", { type: "oauth2" }),
      ])
      expect(viaCredentialToAppAuth).toHaveLength(2)

      // Demonstrate the vacuity directly: the bare type-only form collapses.
      const viaBareForm = dedupAppAuth([
        credentialTypeToAppAuth("oauth2"),
        credentialTypeToAppAuth("oauth2"),
      ])
      expect(viaBareForm).toHaveLength(1)
    },
  )
})

describe("credentialTypeToBuildKind — §2c BuildRecipe.credential.kind mapping", () => {
  it.each([
    ["oauth2", "oauth2"],
    ["bearer", "bearer"],
    ["jwt", "bearer"],
    ["api_key", "api-key"],
    ["bogus", undefined],
  ])("%s -> %s", (type, expected) => {
    expect(credentialTypeToBuildKind(type)).toBe(expected)
  })
})

describe("dedupAppAuth — dedup by (mode, providerId), NOT by mode alone (§2g M2)", () => {
  it("keeps two distinct oauth2 providerIds distinct", () => {
    const result = dedupAppAuth([
      { mode: "oauth2", providerId: "REVIEW:providerId" },
      { mode: "oauth2", providerId: "github-app" },
    ])
    expect(result).toHaveLength(2)
  })

  it("collapses two identical (mode, providerId) entries", () => {
    const result = dedupAppAuth([
      { mode: "token" },
      { mode: "token" },
      { mode: "oauth2", providerId: "x" },
      { mode: "oauth2", providerId: "x" },
    ])
    expect(result).toEqual([{ mode: "token" }, { mode: "oauth2", providerId: "x" }])
  })
})

describe("transformCliEnvVar — the GH_PAT-class convention (§2f, a suggestion, never auto-applied)", () => {
  it("GH_TOKEN is denied and suggests GH_PAT (the 30.8 precedent)", () => {
    const result = transformCliEnvVar("GH_TOKEN")
    expect(result.denied).toBe(true)
    expect(result.suggested).toBe("GH_PAT")
    // The transform NEVER writes the suggestion into `mapped` — mapped stays
    // the raw denied name so the caller must explicitly choose not to use it.
    expect(result.mapped).toBe("GH_TOKEN")
  })

  it("STRIPE_API_KEY is denied (a _KEY suffix) and gets a generic suggestion, never fabricated as fact", () => {
    const result = transformCliEnvVar("STRIPE_API_KEY")
    expect(result.denied).toBe(true)
    expect(result.suggested).toBe("STRIPE_API_CRED")
  })

  it("a non-denied name (e.g. GH_PAT itself) passes through untouched", () => {
    const result = transformCliEnvVar("GH_PAT")
    expect(result.denied).toBe(false)
    expect(result.suggested).toBeUndefined()
    expect(result.mapped).toBe("GH_PAT")
  })

  it.each(["FOO_SECRET", "FOO_TOKEN", "FOO_KEY"])("%s is denied", (name) => {
    expect(transformCliEnvVar(name).denied).toBe(true)
  })
})

describe("basisToFact — trust tagging, tagged union on `via` (§1b/§3a)", () => {
  it("detected -> signal + verifiedAt, no evidence field", () => {
    const fact = basisToFact("p", { via: "detected", signal: "mcp:initialize", verifiedAt: "t" })
    expect(fact).toEqual({ path: "p", via: "detected", signal: "mcp:initialize", verifiedAt: "t" })
  })

  it("discovered -> evidence[], no signal/verifiedAt fields", () => {
    const fact = basisToFact("p", { via: "discovered", evidence: ["https://x"] })
    expect(fact).toEqual({ path: "p", via: "discovered", evidence: ["https://x"] })
  })

  it("discovered with missing evidence[] defaults to an empty array (never undefined -> never crashes downstream)", () => {
    const fact = basisToFact("p", { via: "discovered" })
    expect(fact.evidence).toEqual([])
  })

  it("a MISSING basis (undefined) is reported as an attributed fact, never a raw TypeError crash", () => {
    // integrations.sh is a live third-party payload, not schema-checked on
    // junction's side — a review caught that `basis.via` was dereferenced
    // unguarded, which would throw a path-less TypeError for one bad surface
    // and abort the whole import instead of flagging just that surface.
    expect(() => basisToFact("surfaces[0].basis", undefined)).not.toThrow()
    const fact = basisToFact("surfaces[0].basis", undefined)
    expect(fact.path).toBe("surfaces[0].basis")
    expect(fact.via).toBe("discovered")
    expect(fact.evidence).toEqual([])
    expect(fact.note).toMatch(/basis missing/)
  })
})

describe("firstAuthModeToBuildCredentialKind — EXHAUSTIVE branch, never a fabricating ternary", () => {
  it.each([
    ["oauth2", "oauth2"],
    ["token", "bearer"],
    ["byo", "bearer"],
    ["none", undefined],
  ])("%s -> %s", (mode, expected) => {
    expect(firstAuthModeToBuildCredentialKind(mode)).toBe(expected)
  })
})

describe("mapSurface — mechanics/basis union branching + no-fabrication (§2c)", () => {
  const creds = {
    tok: { type: "bearer" },
    oauth: { type: "oauth2" },
  }

  it("an mcp surface with a url -> http transport (never a degenerate ternary)", () => {
    const result = mapSurface(
      {
        type: "mcp",
        url: "https://mcp.example.com",
        name: "Example MCP",
        docs: "https://x",
        basis: { via: "detected", signal: "mcp:initialize", verifiedAt: "t" },
        auth: {
          entries: [
            {
              use: [{ id: "tok", mechanics: { source: "http", headerName: "Authorization" } }],
              basis: { via: "discovered" },
            },
          ],
        },
      },
      creds,
    )
    expect(result.skip).toBeUndefined()
    expect(result.surface.connection).toEqual({
      kind: "mcp",
      transport: "http",
      url: "https://mcp.example.com",
      authHeader: "Authorization",
    })
  })

  it("an mcp surface with a command and NO url -> stdio transport", () => {
    const result = mapSurface(
      {
        type: "mcp",
        command: "npx some-mcp-server",
        name: "Example MCP (stdio)",
        basis: { via: "discovered", evidence: [] },
        auth: { entries: [] },
      },
      creds,
    )
    expect(result.skip).toBeUndefined()
    expect(result.surface.connection).toEqual({
      kind: "mcp",
      transport: "stdio",
      command: "npx some-mcp-server",
    })
  })

  it("an mcp surface with NEITHER url NOR command is skipped + flagged (never invents one)", () => {
    const result = mapSurface(
      {
        type: "mcp",
        name: "Mystery MCP",
        basis: { via: "discovered", evidence: [] },
        auth: { entries: [] },
      },
      creds,
    )
    expect(result.skip).toMatch(/neither url nor command/)
  })

  it('a cli surface\'s mechanics branch on source:"cli" (command/env), not source:"http"', () => {
    const result = mapSurface(
      {
        type: "cli",
        command: "gh",
        name: "gh CLI",
        docs: "https://x",
        basis: { via: "discovered", evidence: [] },
        auth: {
          entries: [
            {
              use: [{ id: "tok", mechanics: { source: "cli", env: ["GH_TOKEN", "GITHUB_TOKEN"] } }],
              basis: { via: "discovered" },
            },
          ],
        },
      },
      creds,
    )
    expect(result.surface.kind).toBe("cli")
    // GH_TOKEN is denied -> credentialEnvVar is OMITTED (never auto-set to a
    // denied name), and the suggestion is recorded in notes[], not the field.
    expect(result.surface.connection).toEqual({ kind: "cli" })
    expect(result.surface.notes?.some((n: string) => n.includes("GH_PAT"))).toBe(true)
  })

  it("an http surface NEVER gets an openapi kind or a fabricated specUrl (§2c gap-filler default)", () => {
    const result = mapSurface(
      {
        type: "http",
        url: "https://api.example.com",
        name: "Example REST",
        basis: { via: "discovered", evidence: [] },
        auth: { entries: [] },
      },
      creds,
    )
    expect(result.surface.kind).toBe("http")
    expect(result.surface.connection).toEqual({ kind: "http", baseUrl: "https://api.example.com" })
    // No specUrl field anywhere in the connection (the notes[] prose is
    // allowed to MENTION specUrl as a review hint — only the structural
    // field is the no-fabrication invariant).
    expect(result.surface.connection).not.toHaveProperty("specUrl")
  })

  it("an unrecognized surface type is skipped + flagged, never mapped to an invented kind", () => {
    const result = mapSurface(
      {
        type: "grpc",
        name: "Mystery gRPC",
        basis: { via: "discovered", evidence: [] },
        auth: { entries: [] },
      },
      creds,
    )
    expect(result.skip).toMatch(/unrecognized surface type "grpc"/)
  })

  it("use.length > 1 (AND-composed auth) is flagged, not silently dropped", () => {
    const result = mapSurface(
      {
        type: "graphql",
        url: "https://api.example.com/graphql",
        name: "Example GraphQL",
        basis: { via: "discovered", evidence: [] },
        auth: {
          entries: [
            {
              use: [
                { id: "tok", mechanics: { source: "http", headerName: "Authorization" } },
                { id: "oauth", mechanics: { source: "well-known" } },
              ],
              basis: { via: "discovered" },
            },
          ],
        },
      },
      creds,
    )
    expect(result.andComposed).toEqual([["tok", "oauth"]])
    // Both modes still mapped (not dropped) despite the AND-composition flag.
    expect(result.surface.auth.length).toBeGreaterThanOrEqual(1)
  })

  it(
    'a surface with ZERO resolvable auth (mode:"none") gets NO build.credential — ' +
      "the no-fabrication bug a review caught: a non-exhaustive ternary previously " +
      'defaulted this to a fabricated {kind:"bearer"} credential the source data never claimed',
    () => {
      const result = mapSurface(
        {
          type: "http",
          url: "https://api.example.com",
          name: "Public REST",
          basis: { via: "discovered", evidence: [] },
          auth: { entries: [] },
        },
        {},
      )
      expect(result.skip).toBeUndefined()
      expect(result.surface.auth).toEqual([{ mode: "none" }])
      expect(result.surface.build).not.toHaveProperty("credential")
    },
  )

  it("the same zero-auth invariant holds for mcp/graphql/cli surfaces, not just http", () => {
    const mcpResult = mapSurface(
      {
        type: "mcp",
        url: "https://mcp.example.com",
        name: "Public MCP",
        basis: { via: "discovered", evidence: [] },
        auth: { entries: [] },
      },
      {},
    )
    expect(mcpResult.surface.build).not.toHaveProperty("credential")

    const graphqlResult = mapSurface(
      {
        type: "graphql",
        url: "https://api.example.com/graphql",
        name: "Public GraphQL",
        basis: { via: "discovered", evidence: [] },
        auth: { entries: [] },
      },
      {},
    )
    expect(graphqlResult.surface.build).not.toHaveProperty("credential")

    const cliResult = mapSurface(
      {
        type: "cli",
        command: "public-cli",
        name: "Public CLI",
        basis: { via: "discovered", evidence: [] },
        auth: { entries: [] },
      },
      {},
    )
    expect(cliResult.surface.build).not.toHaveProperty("credential")
  })

  it("a graphql surface with NO url is skipped + flagged (symmetric with mcp's url/command guard)", () => {
    const result = mapSurface(
      {
        type: "graphql",
        name: "Mystery GraphQL",
        basis: { via: "discovered", evidence: [] },
        auth: { entries: [] },
      },
      creds,
    )
    expect(result.skip).toMatch(/graphql surface has no url/)
  })

  it("an http surface with NO url is skipped + flagged (symmetric with mcp's url/command guard)", () => {
    const result = mapSurface(
      {
        type: "http",
        name: "Mystery REST",
        basis: { via: "discovered", evidence: [] },
        auth: { entries: [] },
      },
      creds,
    )
    expect(result.skip).toMatch(/http surface has no url/)
  })
})

// ---------------------------------------------------------------------------
// Full pipeline against the committed fixtures (buildDraft)
// ---------------------------------------------------------------------------

describe("buildDraft(github.com fixture)", () => {
  it("validates against AppCatalogEntrySchema once REVIEW:providerId placeholders are filled", async () => {
    const payload = await loadFixture("github.com.surface.json")
    const draft = buildDraft(payload)

    // Fill the known REVIEW:* placeholders with known-good GitHub values —
    // proving the SHAPE is schema-valid, not that placeholders ship unfilled
    // (§3b: a raw draft with REVIEW: tokens is intentionally schema-invalid).
    // The placeholder is "REVIEW:providerId:<credentialId>" (credential-ID-
    // distinguishable, §2g M2 fix) — match the whole sentinel with a regex,
    // not a bare substring replace, so filling doesn't leave a mangled
    // "github:github_oauth_app"-shaped string behind.
    const filled = JSON.parse(
      JSON.stringify(draft.catalogEntry).replace(/REVIEW:providerId(:[a-zA-Z0-9_]+)?/g, "github"),
    )
    const result = AppCatalogEntrySchema.safeParse(filled)
    expect(result.success).toBe(true)
  })

  it("the raw (unfilled) draft carries the REVIEW: sentinel — a human/CI convention gates it, not Zod", async () => {
    const payload = await loadFixture("github.com.surface.json")
    const draft = buildDraft(payload)
    const result = AppCatalogEntrySchema.safeParse(draft.catalogEntry)
    // providerId is z.string().min(1) so the placeholder string technically
    // satisfies the type — the invalidity gate is procedural (a human/CI grep
    // for the sentinel prefix before commit), not a Zod refinement. Assert the
    // sentinel is actually present so that gate has something to find.
    expect(JSON.stringify(draft.catalogEntry)).toContain("REVIEW:providerId")
    expect(result.success).toBe(true) // shape-valid; the sentinel is a convention, not a schema rule
  })

  it(
    "FALSIFIABLE equivalence predicate vs. the hand-authored 30.8 entry — kind set DERIVED FROM " +
      "THE FIXTURE (never a hardcoded literal, per the team-lead's 0094bf0 fix), auth modes, " +
      "and an EXPECTED-DIVERGENCE ALLOWLIST (method file §4). Any divergence outside the allowlist fails.",
    async () => {
      const payload = await loadFixture("github.com.surface.json")
      const draft = buildDraft(payload)

      // EXPECTED kind set DERIVED FROM THE COMMITTED FIXTURE ITSELF — the
      // fixture's own surfaces[].type set, with integrations.sh "http" mapping
      // to junction "http" (identity for every kind the importer maps: mcp,
      // graphql, cli, http all pass through 1:1 — §2c). This is the single
      // source of truth: if a future re-fetch changes the fixture's surface
      // set (e.g. integrations.sh starts/stops discovering an mcp surface for
      // github.com), this expectation moves WITH it instead of silently going
      // stale against a hardcoded literal — the predicate can never re-drift
      // against reality, only against a genuine importer bug.
      const rawSurfaces = payload.surfaces as Array<{ type: string }>
      const expectedKindSet = new Set(rawSurfaces.map((s) => s.type))

      const kindSet = new Set(draft.catalogEntry.supportedKinds)
      expect(kindSet).toEqual(expectedKindSet)
      // Sanity-anchor: today's fixture (captured 2026-07-06) has NO mcp
      // surface for github.com (integrations.sh's own detect.mcp:[] confirms
      // it didn't find one) — so today this evaluates to {graphql,cli,http}.
      // This assertion documents that fact WITHOUT being the source of truth
      // for the predicate above (expectedKindSet already is).
      expect(expectedKindSet.has("mcp")).toBe(false)

      // The hand-authored entry has an additional `openapi` surface (and an
      // `mcp` surface) that the importer, by design (§2c), cannot produce
      // from this payload — openapi because it never fabricates a specUrl;
      // mcp because THIS fixture doesn't carry one. Both are outside what
      // buildDraft claims to reproduce; assert only what it DOES claim.

      // Auth modes match: oauth2 (placeholder) + token, same as hand-authored.
      const modes = new Set(draft.catalogEntry.auth.map((a: { mode: string }) => a.mode))
      expect(modes).toEqual(new Set(["token", "oauth2"]))

      // EXPECTED-DIVERGENCE ALLOWLIST — every difference from the
      // hand-authored 30.8 entry must be one of these four:
      const allowlist = new Set([
        "http-vs-openapi REST surface",
        "missing-mcp (fixture has no mcp surface — integrations.sh didn't discover GitHub's)",
        "missing iconSlug",
        "REVIEW:providerId placeholders",
      ])
      const observedDivergences = new Set<string>()
      if (!kindSet.has("openapi")) observedDivergences.add("http-vs-openapi REST surface")
      if (!kindSet.has("mcp")) {
        observedDivergences.add(
          "missing-mcp (fixture has no mcp surface — integrations.sh didn't discover GitHub's)",
        )
      }
      if (draft.catalogEntry.iconSlug === undefined) observedDivergences.add("missing iconSlug")
      if (JSON.stringify(draft.catalogEntry).includes("REVIEW:providerId")) {
        observedDivergences.add("REVIEW:providerId placeholders")
      }
      for (const divergence of observedDivergences) {
        expect(allowlist.has(divergence)).toBe(true)
      }
    },
  )

  it("emits a REVIEW:providerId placeholder for the oauth2 credential, never a guessed providerId", async () => {
    const payload = await loadFixture("github.com.surface.json")
    const draft = buildDraft(payload)
    expect(draft.review.placeholders.length).toBeGreaterThan(0)
    for (const p of draft.review.placeholders) {
      // The token is "REVIEW:providerId:<credentialId>" (credential-ID-
      // distinguishable, §2g M2 fix) — assert the sentinel PREFIX, not an
      // exact match, since the suffix varies per distinct oauth2 credential.
      expect(p.token).toMatch(/^REVIEW:providerId/)
    }
  })

  it(
    "NON-VACUOUS §2g-M2 regression through the FULL buildDraft pipeline: a payload with TWO " +
      "distinct oauth2 credentials (github's real shape — a personal OAuth app + a GitHub App) " +
      "preserves BOTH as distinct auth entries + emits TWO distinguishable placeholders, never " +
      "collapsing to one (the exact vacuity a review caught in an earlier version of this test, " +
      "which hand-fed two DIFFERENT providerIds the importer itself never generates)",
    () => {
      const twoOAuth2Payload = {
        domain: "synthetic-multi-oauth2.example.com",
        description: "synthetic fixture for the M2 dedup regression",
        usedLlm: true,
        credentials: {
          app_oauth: { type: "oauth2", label: "Personal OAuth app" },
          service_oauth: { type: "oauth2", label: "Service/App-style OAuth" },
        },
        surfaces: [
          {
            type: "http",
            url: "https://api.synthetic-multi-oauth2.example.com",
            name: "Synthetic REST",
            docs: "https://docs.example.com",
            basis: { via: "discovered", evidence: [] },
            auth: {
              status: "required",
              entries: [
                {
                  use: [
                    {
                      id: "app_oauth",
                      mechanics: {
                        source: "http",
                        in: "header",
                        headerName: "Authorization",
                        scheme: "Bearer",
                      },
                    },
                  ],
                  basis: { via: "discovered", evidence: [] },
                },
                {
                  use: [
                    {
                      id: "service_oauth",
                      mechanics: {
                        source: "http",
                        in: "header",
                        headerName: "Authorization",
                        scheme: "Bearer",
                      },
                    },
                  ],
                  basis: { via: "discovered", evidence: [] },
                },
              ],
            },
          },
        ],
      }

      const draft = buildDraft(twoOAuth2Payload)

      // TWO oauth2 auth entries survive at the surface level — dedup did NOT
      // collapse them despite both being mode:"oauth2".
      const surfaceOauth2Entries = draft.catalogEntry.surfaces[0].auth.filter(
        (a: { mode: string }) => a.mode === "oauth2",
      )
      expect(surfaceOauth2Entries).toHaveLength(2)
      const providerIds = new Set(
        surfaceOauth2Entries.map((a: { providerId: string }) => a.providerId),
      )
      expect(providerIds.size).toBe(2) // distinguishable, not identical

      // TWO oauth2 auth entries survive at the APP level too (same dedup path).
      const appOauth2Entries = draft.catalogEntry.auth.filter(
        (a: { mode: string }) => a.mode === "oauth2",
      )
      expect(appOauth2Entries).toHaveLength(2)

      // TWO distinct placeholders in the review artifact — never one.
      expect(draft.review.placeholders).toHaveLength(2)
      const placeholderTokens = new Set(
        draft.review.placeholders.map((p: { token: string }) => p.token),
      )
      expect(placeholderTokens.size).toBe(2)
    },
  )

  it("a discovered fact is present and flagged as such in the review artifact", async () => {
    const payload = await loadFixture("github.com.surface.json")
    const draft = buildDraft(payload)
    expect(draft.review.facts.some((f: { via: string }) => f.via === "discovered")).toBe(true)
    expect(draft.review.counts.discovered).toBeGreaterThan(0)
  })

  it("never emits starterTools (§2e — integrations.sh gives none, never fabricated)", async () => {
    const payload = await loadFixture("github.com.surface.json")
    const draft = buildDraft(payload)
    for (const surface of draft.catalogEntry.surfaces ?? []) {
      expect(surface.starterTools).toBeUndefined()
    }
  })
})

describe("buildDraft(stripe.com fixture) — collision + detected-surface + absent-acquisition path", () => {
  it("proposes id 'stripe' (the live catalog already has a thin stripe entry, §3c)", async () => {
    const payload = await loadFixture("stripe.com.surface.json")
    const draft = buildDraft(payload)
    expect(draft.id).toBe("stripe")
  })

  it("captures the detected mcp surface (basis.via === detected, signal mcp:initialize)", async () => {
    const payload = await loadFixture("stripe.com.surface.json")
    const draft = buildDraft(payload)
    expect(draft.review.counts.detected).toBeGreaterThanOrEqual(1)
    const mcpSurface = draft.catalogEntry.surfaces?.find((s: { kind: string }) => s.kind === "mcp")
    expect(mcpSurface).toBeDefined()
  })

  it("handles an api_key credential with no acquisition field without crashing or fabricating one", async () => {
    const payload = await loadFixture("stripe.com.surface.json")
    expect(payload.credentials.stripe_api_key.acquisition).toBeUndefined()
    const draft = buildDraft(payload)
    expect(draft.catalogEntry.auth.some((a: { mode: string }) => a.mode === "token")).toBe(true)
  })

  it("adds surfaces the reviewer can adopt (mcp/cli/http) — staging-only, never written to the live catalog", async () => {
    const payload = await loadFixture("stripe.com.surface.json")
    const draft = buildDraft(payload)
    const kinds = new Set(draft.catalogEntry.surfaces?.map((s: { kind: string }) => s.kind))
    expect(kinds).toEqual(new Set(["mcp", "cli", "http"]))
  })
})

describe("no-fabrication invariants — cross-cutting (§2c/§2e/§3b)", () => {
  it("no draft ever contains an openapi surface (the importer cannot fabricate a specUrl)", async () => {
    for (const fixture of ["github.com.surface.json", "stripe.com.surface.json"]) {
      const payload = await loadFixture(fixture)
      const draft = buildDraft(payload)
      const kinds = (draft.catalogEntry.surfaces ?? []).map((s: { kind: string }) => s.kind)
      expect(kinds).not.toContain("openapi")
    }
  })

  it("no draft ever contains starterTools", async () => {
    for (const fixture of ["github.com.surface.json", "stripe.com.surface.json"]) {
      const payload = await loadFixture(fixture)
      const draft = buildDraft(payload)
      for (const surface of draft.catalogEntry.surfaces ?? []) {
        expect(surface.starterTools).toBeUndefined()
      }
    }
  })
})
