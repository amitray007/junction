// SPDX-License-Identifier: AGPL-3.0-only
// CliConnectionSchema — sandboxed code-execution source descriptor.
// Data only — no runtime deps. Operator-fixed commands; agent supplies only values.
//
// Security contract: argv is a structured template; agent input never widens argv.
// Each segment yields ≤1 argv element. argv[0] must be a literal absolute binary path.
// The secret is injected as ONE env var (credentialEnvVar) — never in argv/logs/results.
// SOURCE-AGNOSTIC: no vendor-specific fields.

import { z } from "zod"
import {
  hasUnsafePathChars,
  isInterpreterDenylistedEnvKey,
  isJunctionReservedEnvKey,
} from "../sandbox/index.js"
import { ExtractedCliSchemaSchema } from "./cli-schema.js"
import { looksLikeCatastrophicRegex } from "./http-connection.js"

// ---------------------------------------------------------------------------
// Arg declarations — operator specifies the shape; agent fills the values
// ---------------------------------------------------------------------------

/**
 * A single declared arg slot. The agent fills the value; the provider validates
 * it against these constraints before it reaches argv.
 *
 * type:"path" → value must be relative, no ".." components, joins within cwd.
 */
export const CliArgSchema = z
  .object({
    /** Machine-stable name (must match argv segment {kind:"arg", name} references). */
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, "arg name must match ^[a-z][a-z0-9_]*$"),
    /** Human-readable description forwarded to the agent as the tool input schema description. */
    description: z.string().optional(),
    /** Value type — drives arg validation and JSON Schema generation. */
    type: z.enum(["string", "number", "boolean", "enum", "path"]),
    /** Whether the agent must supply this arg. If false (default), absent → omit the segment. */
    required: z.boolean().optional().default(false),
    /** For type:"enum" — the allowed values. Must contain at least one entry. */
    enum: z.array(z.string()).min(1).optional(),
    /**
     * Anchored regex pattern (without /slashes/) to restrict string/path/enum values.
     * Applied as new RegExp(`^(?:${pattern})$`) at validation time.
     */
    pattern: z.string().optional(),
    /** Max length (character count) for string/path values. Hard cap: 4096. */
    maxLength: z.number().int().positive().max(4096).optional(),
  })
  .refine((a) => a.type !== "enum" || (a.enum !== undefined && a.enum.length > 0), {
    message: 'type:"enum" requires a non-empty `enum` array',
    path: ["enum"],
  })
  .refine((a) => a.pattern === undefined || a.maxLength !== undefined, {
    // ReDoS guard: a catastrophic-backtracking operator pattern run against an
    // unbounded agent value can hang the event loop. Require maxLength with pattern.
    message: "`maxLength` is required when `pattern` is set (bounds regex input)",
    path: ["maxLength"],
  })
  .refine((a) => a.pattern === undefined || !looksLikeCatastrophicRegex(a.pattern), {
    // ReDoS guard (pattern shape, 32.13 Slice D3): reject the classic nested-
    // quantifier footgun at author-time — mirrors the HTTP schema's identical
    // guard on HttpParamSchema.pattern (inc-30.7). The CLI surface had the
    // maxLength-required guard above but never this shape check, leaving a
    // pathological pattern like `(\w+)+$` acceptable as long as maxLength was
    // set — still enough input to backtrack catastrophically within a bounded
    // string.
    message: "`pattern` has a nested-quantifier shape that risks catastrophic backtracking (ReDoS)",
    path: ["pattern"],
  })

export type CliArg = z.infer<typeof CliArgSchema>

// ---------------------------------------------------------------------------
// Argv segments — discriminated literal/arg template
// ---------------------------------------------------------------------------

/**
 * A static value written literally into argv. Use for the binary path (argv[0]),
 * subcommands, flag names ("--output"), separators ("--"), and any other
 * operator-fixed tokens the agent may not vary.
 */
const CliArgvLiteralSchema = z.object({
  kind: z.literal("literal"),
  /** The exact string placed in this argv position. */
  value: z.string().min(1),
})

/**
 * A slot that the agent fills. At runtime: exactly one element `(prefix??"") + String(validatedValue)`.
 * If the arg is optional and absent, this element is omitted from argv (≤1 element per segment).
 */
const CliArgvArgSchema = z.object({
  kind: z.literal("arg"),
  /** Must match one of the tool's declared arg names. */
  name: z.string(),
  /** Optional static prefix prepended to the validated value (e.g. "--output="). */
  prefix: z.string().optional(),
})

/** Discriminated argv segment — operator-fixed literal or agent-filled arg slot. */
export const CliArgvSegmentSchema = z.discriminatedUnion("kind", [
  CliArgvLiteralSchema,
  CliArgvArgSchema,
])

export type CliArgvSegment = z.infer<typeof CliArgvSegmentSchema>

// ---------------------------------------------------------------------------
// Per-tool sandbox policy
// ---------------------------------------------------------------------------

/**
 * Sandbox policy for one tool. The operator sets all of these; the agent cannot
 * override any of them. Passed to createSandbox().runCommand() at call time.
 */
export const CliPolicySchema = z.object({
  /** Absolute cwd for the child process. Must be within readPaths or writePaths. */
  cwd: z
    .string()
    .min(1)
    .refine((p) => p.startsWith("/"), { message: "cwd must be an absolute path" }),
  /** Absolute paths the child may read. Should include cwd as a minimum. */
  readPaths: z.array(z.string()),
  /** Absolute paths the child may write. */
  writePaths: z.array(z.string()),
  /** host[:port] allowlist; [] = network fully denied. */
  allowNet: z.array(z.string()),
  /** Hard SIGKILL ceiling in ms (max 10 minutes). */
  timeoutMs: z.number().int().positive().max(600_000),
  /** Static env entries merged with the credential env var in policy.env. */
  envAllow: z.record(z.string(), z.string()).optional().default({}),
})

export type CliPolicy = z.infer<typeof CliPolicySchema>

// ---------------------------------------------------------------------------
// Tool descriptor — one operator-declared command = one MCP tool
// ---------------------------------------------------------------------------

/**
 * One operator-declared command. Becomes one namespaced MCP tool.
 *
 * Security invariants:
 *   - argv[0] MUST be a literal segment with an absolute binary path (sandbox has no PATH).
 *   - Each segment yields ≤1 argv element — the agent cannot widen argv.
 *   - Declared args are the only surface where the agent provides input.
 */
export const CliToolSchema = z
  .object({
    /** Raw MCP tool name (namespaced by the proxy). Must match ^[a-z][a-z0-9_]*$. */
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, "tool name must match ^[a-z][a-z0-9_]*$"),
    description: z.string().optional(),
    /**
     * Ordered argv template. At least one segment required.
     * At call time: literal→value; arg→(prefix??"")+(validated value);
     * optional-absent arg → omit (no element emitted for that slot).
     */
    argv: z.array(CliArgvSegmentSchema).min(1),
    /** Declared arg slots. Agent must supply required ones; optional may be absent. */
    args: z.array(CliArgSchema).optional().default([]),
    /** Per-tool sandbox policy. */
    policy: CliPolicySchema,
  })
  .refine(
    (tool) => {
      // SECURITY: argv[0] must be a literal with an absolute path.
      // The sandbox has no PATH; an explicit binary path is required.
      const first = tool.argv[0]
      if (first === undefined) return false
      if (first.kind !== "literal") return false
      return first.value.startsWith("/")
    },
    {
      message:
        'argv[0] must be a {kind:"literal"} segment with an absolute binary path (starts with "/")',
    },
  )
  .refine(
    (tool) => {
      // SECURITY (32.13 Slice D1): argv[0]'s dirname is interpolated directly into
      // the Seatbelt SBPL profile (seatbelt.ts's readSources / `(allow file-read*
      // (subpath "${p}"))`) — the SAME metachar class validatePolicy already
      // checks for readPaths/writePaths/cwd via hasUnsafePathChars, but argv[0]
      // itself was never checked, leaving one profile-input surface unguarded
      // (also reachable by the Deno tier via the same binaryPath). Reject at
      // author-time rather than at sandbox-generation time.
      const first = tool.argv[0]
      if (first === undefined || first.kind !== "literal") return true // covered by the prior refine
      return !hasUnsafePathChars(first.value)
    },
    {
      message:
        'argv[0] must not contain unsafe metacharacters (" \\ ( ) , or control characters) — it is interpolated into the sandbox profile',
    },
  )
  .refine(
    (tool) => {
      // Every {kind:"arg"} segment must reference a DECLARED arg. An argv slot
      // naming an undeclared arg would, at call time, resolve to undefined and be
      // SILENTLY OMITTED from argv (buildArgv) — the operator's intended argument
      // vanishes. This is the authoritative backstop for a mis-assembled descriptor
      // (e.g. the web edit path serialising a literal `$foo` into an arg segment):
      // catch it here at parse rather than let a corrupted command execute.
      const declared = new Set(tool.args.map((a) => a.name))
      return tool.argv.every((seg) => seg.kind !== "arg" || declared.has(seg.name))
    },
    {
      message:
        "every argv arg segment must reference a declared arg (an undeclared arg slot is silently dropped at call time)",
    },
  )

export type CliTool = z.infer<typeof CliToolSchema>

// ---------------------------------------------------------------------------
// Connection descriptor
// ---------------------------------------------------------------------------
//
// docs/specs/2026-07-16-cli-exploratory-mode.md — CliConnection gains a mode:
//   - "declared" (default, back-compat): existing { tools, credentialEnvVar? }.
//     Stored rows predating this increment have NO `mode` field at all — they
//     MUST still parse as declared (sacred back-compat; see cli-connection.test.ts).
//   - "full-access": a single pinned binary the agent drives via execute/help
//     (41.3), plus the persisted extracted --help tree (41.2) and optional
//     named shortcuts (declared CliTools, demoted to sugar; 41.5).

/**
 * credentialEnvVar's shape + denylist refine, shared verbatim by both the
 * declared and full-access branches (same rule, same message). Factored here
 * rather than duplicated because BOTH branches must react identically to any
 * future denylist change — unlike the branches' other fields, which differ.
 */
const CredentialEnvVarSchema = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]*$/,
    "credentialEnvVar must be a valid env-var name (A-Z, 0-9, _; starts with A-Z or _)",
  )
  .optional()

/**
 * Mirrors validatePolicy's isDenylistedEnvKey so a descriptor that would be
 * rejected at call-time is rejected at add-time instead (lock-step, inc 41
 * Fable ruling — sourced from the SAME shared sandbox/env-denylist.js
 * predicates validatePolicy consumes, not a re-implemented copy). Extending
 * this list? Add a name to the parity corpus in cli-connection.test.ts —
 * additions here are invisible to the lock-step test unless the corpus grows
 * too.
 */
function isDenylistedCredentialEnvVar(name: string): boolean {
  return isJunctionReservedEnvKey(name) || isInterpreterDenylistedEnvKey(name)
}

const CREDENTIAL_ENV_VAR_DENYLIST_MESSAGE =
  "credentialEnvVar must not start with JUNCTION_ (reserved namespace) and must not be a " +
  "dynamic-linker/interpreter name (LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT, DYLD_*, NODE_OPTIONS) " +
  "— ordinary credential names like GH_TOKEN, AWS_SECRET_ACCESS_KEY, or NPM_TOKEN are fine"

// (The Fable Q3 credential disclosure copy is rendered by the web full-access
// panel directly — a client component can't import this core module, so the
// string lives at the render site rather than as an unused core export here.)

/**
 * Sandboxed CLI source descriptor. Meaningful when Platform.kind === "cli".
 *
 * SECURITY: The credential secret never appears in argv, logs, or tool results.
 * It is injected as a single env var (credentialEnvVar) into policy.env at call
 * time. When credentialEnvVar is absent or no credential is bound, no secret is
 * added to the environment.
 *
 * credentialEnvVar MUST NOT start with JUNCTION_ (junction's reserved env-var
 * namespace — JUNCTION_MASTER_KEY, JUNCTION_MASTER_KEY_FILE, JUNCTION_HOME,
 * and any future JUNCTION_* var) and MUST NOT be a dynamic-linker/interpreter
 * name (LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT, DYLD_*, NODE_OPTIONS). Ordinary
 * credential env-var names — including ones ending in _TOKEN/_SECRET/_KEY,
 * such as GH_TOKEN (the only var `gh` reads) — are accepted: the injected
 * value is always the user's own store-resolved credential, and sandbox env
 * is an explicit allowlist that never inherits process.env, so a suffix
 * heuristic added no real protection. (inc 41 Fable ruling; see
 * docs/futures/revisit-when.md, resolved row.)
 */
const DeclaredCliConnectionSchema = z
  .object({
    /**
     * Discriminant. Optional + defaulted so a legacy stored row with NO
     * `mode` field at all (every CLI platform before this increment) still
     * parses as declared — this default is the entire back-compat mechanism.
     */
    mode: z.literal("declared").optional().default("declared"),
    /** One or more operator-declared commands — each becomes one namespaced MCP tool. */
    tools: z.array(CliToolSchema).min(1),
    /**
     * Env-var name the credential secret is injected under in the child environment.
     * Absent → no secret is injected (suitable for public/no-auth commands).
     * Must be a valid env-var identifier (A-Z, digits, underscore; starts with A-Z or _).
     * Must NOT end in _TOKEN, _SECRET, or _KEY (validatePolicy secret-denylist).
     */
    credentialEnvVar: CredentialEnvVarSchema,
  })
  .refine(
    (conn) => !conn.credentialEnvVar || !isDenylistedCredentialEnvVar(conn.credentialEnvVar),
    {
      message: CREDENTIAL_ENV_VAR_DENYLIST_MESSAGE,
      path: ["credentialEnvVar"],
    },
  )

/**
 * Full CLI access (docs/specs/2026-07-16-cli-exploratory-mode.md §4 Layer 0).
 * The platform is a single pinned binary the agent drives via execute/help
 * (41.3) instead of a fixed per-tool argv template. `policy` is ONE
 * platform-level CliPolicy (not per-tool, unlike declared's CliTool.policy).
 */
const FullAccessCliConnectionSchema = z
  .object({
    mode: z.literal("full-access"),
    /**
     * The resolved absolute realpath of the pinned binary (Fable Q1). Reuses
     * the identical argv[0] guards CliToolSchema applies: must be absolute
     * (sandbox has no PATH) and metachar-clean (interpolated into the
     * Seatbelt SBPL profile).
     */
    binaryPath: z
      .string()
      .min(1)
      .refine((p) => p.startsWith("/"), {
        message: 'binaryPath must be an absolute path (starts with "/") — the sandbox has no PATH',
      })
      .refine((p) => !hasUnsafePathChars(p), {
        message:
          'binaryPath must not contain unsafe metacharacters (" \\ ( ) , or control characters) — it is interpolated into the sandbox profile',
      }),
    credentialEnvVar: CredentialEnvVarSchema,
    /** ONE platform-level sandbox policy for the binary (not per-tool). */
    policy: CliPolicySchema,
    /** The persisted recursive --help tree (41.2 extracts it; this slice only stores/validates it). */
    schema: ExtractedCliSchemaSchema,
    /** Optional named saved commands — declared CliTool machinery, demoted to sugar (41.5). */
    shortcuts: z.array(CliToolSchema).optional(),
  })
  .refine(
    (conn) => !conn.credentialEnvVar || !isDenylistedCredentialEnvVar(conn.credentialEnvVar),
    {
      message: CREDENTIAL_ENV_VAR_DENYLIST_MESSAGE,
      path: ["credentialEnvVar"],
    },
  )

/**
 * Mode-tagged union. Order matters for back-compat: FullAccess requires a
 * literal `mode:"full-access"`, so any object lacking `mode` (every legacy
 * stored row) fails that branch and falls through to Declared, whose `mode`
 * is optional+defaulted. Explicit `mode:"declared"` also lands in Declared.
 */
export const CliConnectionSchema = z.union([
  FullAccessCliConnectionSchema,
  DeclaredCliConnectionSchema,
])

export type DeclaredCliConnection = z.infer<typeof DeclaredCliConnectionSchema>
export type FullAccessCliConnection = z.infer<typeof FullAccessCliConnectionSchema>
export type CliConnection = z.infer<typeof CliConnectionSchema>

/** Discriminates a validated CliConnection — true iff it's the full-access branch. */
export function isFullAccess(c: CliConnection): c is FullAccessCliConnection {
  return c.mode === "full-access"
}

// ---------------------------------------------------------------------------
// CliSecret — the resolved credential handed to createCliProvider
// ---------------------------------------------------------------------------

/**
 * The resolved credential secret for a CLI source, tagged by CredentialKind so
 * createCliProvider knows whether to inject the value directly (env) or
 * materialize it to a 0600 temp file and inject the PATH (file).
 *
 * This is the ONLY seam that widens for the file-kind mechanics (increment
 * 28.9 slice D): the mcp/openapi/graphql branches of buildProvider are
 * untouched — they keep consuming a plain `string | null`. Only the cli
 * branch constructs/consumes `CliSecret`.
 */
export type CliSecret = { kind: "env" | "file"; value: string }
