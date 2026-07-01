// SPDX-License-Identifier: AGPL-3.0-only
// CliConnectionSchema — sandboxed code-execution source descriptor.
// Data only — no runtime deps. Operator-fixed commands; agent supplies only values.
//
// Security contract: argv is a structured template; agent input never widens argv.
// Each segment yields ≤1 argv element. argv[0] must be a literal absolute binary path.
// The secret is injected as ONE env var (credentialEnvVar) — never in argv/logs/results.
// SOURCE-AGNOSTIC: no vendor-specific fields.

import { z } from "zod"

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

/**
 * Sandboxed CLI source descriptor. Meaningful when Platform.kind === "cli".
 *
 * SECURITY: The credential secret never appears in argv, logs, or tool results.
 * It is injected as a single env var (credentialEnvVar) into policy.env at call
 * time. When credentialEnvVar is absent or no credential is bound, no secret is
 * added to the environment.
 *
 * credentialEnvVar MUST NOT end in _TOKEN, _SECRET, or _KEY because those
 * suffixes match validatePolicy's secret-denylist heuristic. Use e.g. GH_PAT,
 * API_AUTH, MYSERVICE_CRED. See docs/futures/revisit-when.md for the planned
 * guard-relaxation increment.
 */
export const CliConnectionSchema = z
  .object({
    /** One or more operator-declared commands — each becomes one namespaced MCP tool. */
    tools: z.array(CliToolSchema).min(1),
    /**
     * Env-var name the credential secret is injected under in the child environment.
     * Absent → no secret is injected (suitable for public/no-auth commands).
     * Must be a valid env-var identifier (A-Z, digits, underscore; starts with A-Z or _).
     * Must NOT end in _TOKEN, _SECRET, or _KEY (validatePolicy secret-denylist).
     */
    credentialEnvVar: z
      .string()
      .regex(
        /^[A-Z_][A-Z0-9_]*$/,
        "credentialEnvVar must be a valid env-var name (A-Z, 0-9, _; starts with A-Z or _)",
      )
      .optional(),
  })
  .refine(
    (conn) => {
      if (!conn.credentialEnvVar) return true
      // Heuristic-suffix denylist + exact master-key names (incl. _FILE, which the
      // _KEY$ suffix misses). Mirrors validatePolicy so a descriptor that would be
      // rejected at call-time is rejected at add-time instead.
      const name = conn.credentialEnvVar
      if (/_TOKEN$|_SECRET$|_KEY$/.test(name)) return false
      if (name === "JUNCTION_MASTER_KEY" || name === "JUNCTION_MASTER_KEY_FILE") return false
      return true
    },
    {
      message:
        "credentialEnvVar must not end in _TOKEN/_SECRET/_KEY or be a JUNCTION_MASTER_KEY* name " +
        "(validatePolicy denylist — use GH_PAT, API_AUTH, or similar instead)",
      path: ["credentialEnvVar"],
    },
  )

export type CliConnection = z.infer<typeof CliConnectionSchema>
