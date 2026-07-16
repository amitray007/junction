// SPDX-License-Identifier: AGPL-3.0-only
// McpConnectionSchema — generic MCP transport descriptor.
// Discriminated union: http (remote URL) or stdio (local command).
// SOURCE-AGNOSTIC: no vendor-specific fields. Connection details are DATA,
// not code (no "if platform === 'github'" anywhere). Design spec §4 + method 10.

import { z } from "zod"
import { isInterpreterDenylistedEnvKey } from "../sandbox/index.js"

// The dynamic-linker/interpreter env-key denylist class (LD_PRELOAD,
// NODE_OPTIONS, DYLD_* by prefix, …) is hoisted to sandbox/env-denylist.ts
// (inc 41 Fable ruling) and shared with validatePolicy + the CLI
// credentialEnvVar refine — see isInterpreterDenylistedEnvKey below.
// PATH/HOME are intentionally NOT denylisted (dual-use, grant nothing beyond
// the operator-declared command). See the stdio-env refine below.

// ---------------------------------------------------------------------------
// McpConnectionSchema
// ---------------------------------------------------------------------------

/**
 * Generic MCP connection descriptor — transport is the discriminant.
 * Meaningful when Platform.kind === "mcp".
 *
 * Two transports cover all MCP sources:
 *   - http  : remote MCP server accessible via URL (e.g. hosted MCP APIs)
 *   - stdio : local MCP server launched as a subprocess (e.g. npx packages)
 *
 * Bearer credentials are injected at call-time (increment B) — not stored here.
 */
/**
 * HTTP MCP auth descriptor — discriminated on `scheme` (additive, inc 28.9).
 *
 *   - bearer: emits "Bearer <token>" in `header` (default "Authorization") —
 *     unchanged from before this increment; existing persisted rows re-parse
 *     cleanly (they carry scheme:"bearer" + a materialized header).
 *   - header (NEW): emits the RAW secret in header `name`, no "Bearer " prefix
 *     — for a server expecting e.g. "X-Api-Key: <raw>".
 */
export const McpHttpAuthSchema = z.discriminatedUnion("scheme", [
  z.object({
    scheme: z.literal("bearer"),
    /** HTTP header name that carries the bearer token. Default: "Authorization". */
    header: z.string().min(1).default("Authorization"),
  }),
  z.object({
    scheme: z.literal("header"),
    /** HTTP header name that carries the RAW secret value (no prefix). */
    name: z.string().min(1),
  }),
])

export type McpHttpAuth = z.infer<typeof McpHttpAuthSchema>

export const McpConnectionSchema = z.discriminatedUnion("transport", [
  /**
   * HTTP transport — point junction at any remote MCP URL.
   *
   * auth: bearer (Authorization: Bearer <token>, or a custom header still
   * carrying the "Bearer " prefix) or header (raw secret, no prefix) — see
   * McpHttpAuthSchema.
   */
  z.object({
    transport: z.literal("http"),
    url: z.string().url(),
    auth: McpHttpAuthSchema.optional(),
  }),
  /**
   * Stdio transport — launch an MCP server binary as a child process.
   *
   * command: executable to run (e.g. "npx", "uvx", "/usr/local/bin/my-mcp").
   * args: arguments passed to the command (default []).
   * tokenEnvVar: environment variable the bearer token is injected into (optional).
   * env: operator-declared static environment variables (optional, non-secret).
   */
  z
    .object({
      transport: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      /** Env-var name the bearer token is injected into (e.g. "GITHUB_TOKEN"). */
      tokenEnvVar: z.string().min(1).optional(),
      /**
       * Operator-declared static environment variables passed to the child MCP server
       * (e.g. { NODE_ENV: "production", GH_HOST: "github.example.com" }). These are
       * NON-SECRET config — the credential secret still rides ONLY in tokenEnvVar.
       * Keys must be valid env-var identifiers. Merged into the controlled child env
       * AFTER getDefaultEnvironment() and BEFORE the tokenEnvVar injection, so a static
       * entry can neither overwrite the injected credential nor is it allowed to clobber
       * the credential key (see connect.ts).
       */
      env: z
        .record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env var name must be a valid identifier"),
          z.string(),
        )
        .optional(),
    })
    .refine(
      (stdio) => {
        if (!stdio.env) return true
        // SECURITY: a static env key must not collide with the credential slot
        // (would let a static value pre-empt/shadow the injected secret) or with
        // the master-key names (never let an operator inject/shadow the master
        // key into a child). Mirrors CliConnectionSchema's credentialEnvVar denylist.
        const keys = Object.keys(stdio.env)
        if (stdio.tokenEnvVar !== undefined && keys.includes(stdio.tokenEnvVar)) return false
        if (keys.includes("JUNCTION_MASTER_KEY") || keys.includes("JUNCTION_MASTER_KEY_FILE"))
          return false
        // SECURITY: the stdio MCP child is NOT sandboxed (plain spawn, full user
        // privileges). A static env entry that hijacks the dynamic linker or the
        // Node/interpreter runtime = arbitrary code execution in the child — the
        // real threat is a pasted/imported platform config the operator didn't
        // author (LD_PRELOAD → code injection, NODE_OPTIONS → --require arbitrary
        // JS). PATH is deliberately NOT blocked — it's dual-use and grants nothing
        // beyond the operator-declared command. Case-insensitive; DYLD_* by prefix.
        for (const key of keys) {
          if (isInterpreterDenylistedEnvKey(key)) return false
        }
        return true
      },
      {
        message:
          "env keys must not include tokenEnvVar, JUNCTION_MASTER_KEY/JUNCTION_MASTER_KEY_FILE, " +
          "or a dynamic-linker/interpreter name (LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT, DYLD_*, " +
          "NODE_OPTIONS) — those would let a pasted config run code in the unsandboxed MCP child",
        path: ["env"],
      },
    ),
])

export type McpConnection = z.infer<typeof McpConnectionSchema>
