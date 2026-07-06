// SPDX-License-Identifier: AGPL-3.0-only
// AppCatalogEntrySchema — the richer catalog entry (increment 30.8). A superset
// of catalog.ts's AppDefinition: adds the surface dimension (per-surface
// connection templates + auth + build recipe + verify) and app-level `help`.
// Design doc: docs/design/app-surface-model.md §4.6/§4.7. Method file:
// docs/methods/30.8-app-catalog-schema.md.
//
// This schema is DATA-ONLY — no HTTP, no I/O, no execution. The `build` recipe
// and `verify` hint are declarative fields a LATER increment (30.11) interprets
// and runs; 30.8 only defines and validates their shape. Per-surface
// `starterTools` REUSE the shipped HttpRequestToolSchema/CliToolSchema — they
// are not redefined here (see §2e).

import { z } from "zod"

import { CliToolSchema } from "../schema/cli-connection.js"
import { HttpRequestToolSchema } from "../schema/http-connection.js"
import { OpenApiSelectSchema } from "../schema/openapi-connection.js"
import { PlatformKind } from "../schema/platform.js"

// ---------------------------------------------------------------------------
// AppAuth — mirrors catalog.ts's AppAuth (kept identical for back-compat)
// ---------------------------------------------------------------------------

export const AppAuthSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("oauth2"), providerId: z.string().min(1) }),
  z.object({ mode: z.literal("token") }),
  z.object({ mode: z.literal("byo") }),
  z.object({ mode: z.literal("none") }),
])

export type AppAuth = z.infer<typeof AppAuthSchema>

// ---------------------------------------------------------------------------
// VerifyHint — declarative-only in 30.8 (does NOT run); 30.11 wires each kind
// to a real verifier. Only ONE shipped verify primitive exists today
// (OpenApiConnectionSchema.verifyOperationId) — the other kinds are
// declarative placeholders for a probe 30.11 will implement. `none` is the
// honest "not verifiable" member (cli / an empty http surface).
// ---------------------------------------------------------------------------

export const VerifyHintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("openapi"), operationId: z.string().min(1) }),
  z.object({ kind: z.literal("mcp"), listTools: z.literal(true) }),
  z.object({ kind: z.literal("graphql"), typenameProbe: z.literal(true) }),
  z.object({ kind: z.literal("none") }),
])

export type VerifyHint = z.infer<typeof VerifyHintSchema>

// ---------------------------------------------------------------------------
// Per-surface `connection` template — one variant per kind (§2c).
//
// Each is a partial that the (later, 30.11) build recipe interpreter completes
// into a real addXPlatform call. Kept tight to the add-INPUT shape (§1d of the
// method file), NOT the stored connection shape — e.g. the http/cli templates
// carry no `tools` (those live in `starterTools`, merged in at connect time),
// so they do NOT satisfy HttpConnectionSchema/CliConnectionSchema themselves
// (whose `tools.min(1)` would reject an empty template) — that's intentional.
// ---------------------------------------------------------------------------

export const AppSurfaceConnectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mcp"),
      transport: z.enum(["http", "stdio"]),
      // http
      url: z.string().url().optional(),
      authHeader: z.string().min(1).optional(),
      // stdio
      command: z.string().min(1).optional(),
      args: z.array(z.string()).optional(),
      tokenEnvVar: z.string().min(1).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    // Couple the field to the discriminant: an http-transport template with no
    // url (or a stdio-transport template with no command) validates as DATA
    // but is malformed — it would fail LATE in 30.11's connect interpreter
    // instead of at authoring time. Reject it here.
    .refine((c) => c.transport !== "http" || c.url !== undefined, {
      message: 'mcp connection template with transport:"http" must declare a url',
      path: ["url"],
    })
    .refine((c) => c.transport !== "stdio" || c.command !== undefined, {
      message: 'mcp connection template with transport:"stdio" must declare a command',
      path: ["command"],
    }),
  z.object({
    kind: z.literal("openapi"),
    specUrl: z.string().url(),
    baseUrl: z.string().url().optional(),
    maxTools: z.number().int().positive().optional(),
    // Reuses the shipped OpenApiSelectSchema verbatim (not redefined) — same
    // reuse discipline as starterTools (§2e).
    select: OpenApiSelectSchema.optional(),
    verifyOperationId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("graphql"),
    endpoint: z.string().url(),
    defaultHeaders: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    kind: z.literal("http"),
    baseUrl: z.string().url(),
    defaultHeaders: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    kind: z.literal("cli"),
    credentialEnvVar: z.string().min(1).optional(),
  }),
])

export type AppSurfaceConnection = z.infer<typeof AppSurfaceConnectionSchema>

// ---------------------------------------------------------------------------
// BuildRecipe (§2d) — DECLARATIVE data only; 30.8 does not execute it.
// ---------------------------------------------------------------------------

export const CredentialKindForBuildSchema = z.enum(["api-key", "bearer", "oauth2", "file", "env"])

export const BuildRecipeSchema = z.object({
  /** e.g. "{app}" or "{app}-{kind}" (multi-surface, 30.12). */
  platformIdTemplate: z.string().min(1),
  /** mcp/openapi/graphql map to a flattened AddXPlatformInput; http/cli use an opaque descriptor. */
  via: z.enum(["flattened", "descriptor"]),
  credential: z.object({
    kind: CredentialKindForBuildSchema,
    from: z.literal("auth"),
  }),
})

export type BuildRecipe = z.infer<typeof BuildRecipeSchema>

// ---------------------------------------------------------------------------
// AppSurface — one connected way to reach the app (§2b)
// ---------------------------------------------------------------------------

export const AppSurfaceSchema = z.object({
  kind: PlatformKind,
  displayName: z.string().min(1),
  connection: AppSurfaceConnectionSchema,
  /**
   * Which auth mechanisms work for THIS surface (first = default). Independent
   * of the app-level `auth[]` (the union across surfaces, kept for
   * AppDefinition back-compat) — a surface's auth is NOT constrained to be a
   * subset of the app-level auth[]. groupByApp still reads app-level auth[] only.
   */
  auth: z.array(AppAuthSchema).min(1),
  build: BuildRecipeSchema,
  /** Declarative only in 30.8 — 30.11 executes the probe this describes. */
  verify: VerifyHintSchema.optional(),
  docs: z.string().optional(),
  agentGuidance: z.string().optional(),
  /**
   * User-authored starter tools (http/cli surfaces only) — REUSES the shipped
   * HttpRequestToolSchema/CliToolSchema verbatim (no redefinition). Gap-filler
   * rule (§4.7): ship starters ONLY where this surface is the recommended path.
   */
  starterTools: z.array(z.union([HttpRequestToolSchema, CliToolSchema])).optional(),
  /** Rot-prone tier — quirks/rate-limits. NOT load-bearing; "may be stale". */
  notes: z.array(z.string()).optional(),
})

export type AppSurface = z.infer<typeof AppSurfaceSchema>

// ---------------------------------------------------------------------------
// App-level `help` — rich, durable info (may live in help.json, merged on load)
// ---------------------------------------------------------------------------

export const AppHelpSchema = z.object({
  category: z.array(z.string().min(1)).optional(),
  homepage: z.string().url().optional(),
  statusPage: z.string().url().optional(),
  description: z.string().optional(),
  /** Short, factual — feeds MCP `instructions` + tool descriptions. Capability description, never behavior scripting. */
  agentGuidance: z.string().optional(),
  oauthApp: z
    .object({
      registerUrl: z.string().url().optional(),
      callbackPath: z.string().optional(),
    })
    .optional(),
  provenance: z
    .object({
      authoredBy: z.string().min(1),
      researchedFrom: z.array(z.string()).optional(),
      lastReviewed: z.string().optional(),
    })
    .optional(),
  /**
   * Per-platform install commands for a CLI/tool the app needs locally (e.g.
   * `gh`, `stripe`). Durable-rich (§4.6) — commands change rarely.
   */
  install: z
    .object({
      commands: z.record(z.string(), z.string()).optional(),
      verifyCmd: z.string().optional(),
      minVersion: z.string().optional(),
    })
    .optional(),
  /** How a human obtains/sets the credential outside junction's own vault flow. */
  authSetup: z
    .object({
      interactive: z.string().optional(),
      env: z.string().optional(),
      configPath: z.string().optional(),
    })
    .optional(),
  /** Ported free-text notes that don't fit a structured field (e.g. omission rationale). */
  notes: z.array(z.string()).optional(),
})

export type AppHelp = z.infer<typeof AppHelpSchema>

// ---------------------------------------------------------------------------
// AppCatalogEntrySchema — the full entry. Superset of AppDefinition: every
// existing field is preserved verbatim; `surfaces`/`help` are NEW and OPTIONAL
// so a thin/legacy migrated entry (no surfaces authored yet) still validates.
// ---------------------------------------------------------------------------

export const AppCatalogEntrySchema = z.object({
  // --- back-compatible core (every existing AppDefinition field) ---
  id: z.string().min(1),
  displayName: z.string().min(1),
  supportedKinds: z.array(PlatformKind),
  auth: z.array(AppAuthSchema),
  aliases: z.array(z.string().min(1)).optional(),
  setupHints: z.array(z.string()).optional(),
  iconSlug: z.string().min(1).optional(),

  // --- new: the surface dimension ---
  surfaces: z.array(AppSurfaceSchema).optional(),

  // --- new: app-level rich help ---
  help: AppHelpSchema.optional(),
})

export type AppCatalogEntry = z.infer<typeof AppCatalogEntrySchema>
