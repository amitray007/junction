// SPDX-License-Identifier: AGPL-3.0-only
// HttpConnectionSchema — user-authored REST request-tool source descriptor.
// Data only — no runtime deps (fetch client lives in packages/http-client).
// Authoring model = the `cli` surface (operator declares tools[], one tool =
// one MCP tool); request engine = the `openapi` client (path/query/header/body
// binding, injectAuth, byte-cap/timeout). SOURCE-AGNOSTIC: no vendor fields.

import { z } from "zod"

import { OpenApiAuthSchema } from "./openapi-connection.js"

/**
 * Lightweight author-time guard against the classic catastrophic-backtracking
 * (ReDoS) shapes — a quantified group that is itself quantified, e.g. `(a+)+`,
 * `(a*)*`, `(.+)*`, `(x{1,9})+`. The operator's `pattern` is compiled to a RegExp
 * and run against agent-supplied values on EVERY tool call, so a pathological
 * pattern could stall the event loop even within the bounded maxLength. This is a
 * heuristic (not a full safe-regex analysis — that would need an RE2/AST engine,
 * out of scope for a data-only core schema); it rejects the common footgun at
 * add-time. `maxLength` is still required with `pattern` as defence-in-depth.
 * (inc-30.7 CodeRabbit #502/#511.)
 */
function looksLikeCatastrophicRegex(pattern: string): boolean {
  // A group closing then immediately quantified — `)` followed by * + ? or {n,}
  // — where the group's LAST token was itself a quantifier ⇒ nested quantifier.
  return /\([^)]*[*+?}][^)]*\)\s*[*+{]/.test(pattern) || /\([^)]*[*+][^)]*\)[*+?]/.test(pattern)
}

// ---------------------------------------------------------------------------
// Param declarations — operator specifies the shape + location; agent fills values
// ---------------------------------------------------------------------------

/**
 * A single declared param on a request-tool. The agent fills the value; the
 * provider validates it against these constraints, then binds it into the
 * outbound request at the declared location.
 *
 * `in` is the location — the key inversion vs. CLI's argv template: HTTP puts
 * the location on the param itself (mirrors OpenAPI param locations), rather
 * than encoding it into a positional argv segment.
 */
export const HttpParamSchema = z
  .object({
    /**
     * The param name. For `in:"path"` it is BOTH the `{placeholder}` identifier and
     * the agent arg key, so it must be a strict identifier. For query/header it is
     * the on-wire key AND the agent arg key — real HTTP keys are hyphenated
     * (`X-Api-Key`, `If-None-Match`, `Content-Type`), so those charsets are allowed
     * (validated per-`in` in the refine below). (inc-30.7 CodeRabbit #498/#505.)
     */
    name: z.string().min(1),
    /** Where this param binds in the outbound request. */
    in: z.enum(["path", "query", "header", "body"]),
    /** Value type — drives arg validation and JSON Schema generation. */
    type: z.enum(["string", "number", "boolean", "enum"]),
    /** Whether the agent must supply this param. If false (default), absent → omit. */
    required: z.boolean().default(false),
    /** Human-readable description forwarded to the agent as the tool input schema description. */
    description: z.string().optional(),
    /** For type:"enum" — the allowed values. Must contain at least one entry. */
    enum: z.array(z.string()).min(1).optional(),
    /**
     * Anchored regex pattern (without /slashes/) to restrict string values.
     * Applied as new RegExp(`^(?:${pattern})$`) at validation time.
     */
    pattern: z.string().optional(),
    /** Max length (character count) for string values. Hard cap: 4096. */
    maxLength: z.number().int().positive().max(4096).optional(),
  })
  // Per-location name charset (inc-30.7 CodeRabbit #498/#505): path + body names
  // are strict identifiers (path interpolates into the URL; body is the arg key);
  // query + header names are on-wire keys and must allow the hyphenated forms real
  // HTTP uses (X-Api-Key, If-None-Match, Content-Type) — a conservative token set.
  .refine(
    (p) => {
      const strict = /^[a-zA-Z][a-zA-Z0-9_]*$/
      const wireKey = /^[A-Za-z][A-Za-z0-9_-]*$/
      return (p.in === "path" || p.in === "body" ? strict : wireKey).test(p.name)
    },
    {
      message:
        'param name is invalid for its location (path/body: ^[a-zA-Z][a-zA-Z0-9_]*$; query/header may also contain "-")',
      path: ["name"],
    },
  )
  .refine((p) => p.type !== "enum" || (p.enum !== undefined && p.enum.length > 0), {
    message: 'type:"enum" requires a non-empty `enum` array',
    path: ["enum"],
  })
  .refine((p) => p.pattern === undefined || p.maxLength !== undefined, {
    // ReDoS guard (input bound): require maxLength with pattern so a
    // catastrophic-backtracking pattern can't run against an unbounded value.
    message: "`maxLength` is required when `pattern` is set (bounds regex input)",
    path: ["maxLength"],
  })
  .refine((p) => p.pattern === undefined || !looksLikeCatastrophicRegex(p.pattern), {
    // ReDoS guard (pattern shape): reject the classic nested-quantifier footgun
    // at author-time (the pattern runs on every call). (inc-30.7 CodeRabbit #502/#511.)
    message: "`pattern` has a nested-quantifier shape that risks catastrophic backtracking (ReDoS)",
    path: ["pattern"],
  })

export type HttpParam = z.infer<typeof HttpParamSchema>

// ---------------------------------------------------------------------------
// Request-tool descriptor — one operator-declared REST call = one MCP tool
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g

function pathPlaceholders(path: string): Set<string> {
  const names = new Set<string>()
  for (const m of path.matchAll(PLACEHOLDER_RE)) {
    const name = m[1]
    if (name !== undefined) names.add(name)
  }
  return names
}

/** The full list of `{placeholder}` occurrences (WITH duplicates) — for the
 *  repeated-placeholder guard: `String.replace(string, …)` substitutes only the
 *  first occurrence, so `/a/{id}/b/{id}` would leave the 2nd `{id}` literal.
 *  Reject a repeated placeholder at author-time (inc-30.7 correctness review). */
function pathPlaceholderList(path: string): string[] {
  const names: string[] = []
  for (const m of path.matchAll(PLACEHOLDER_RE)) {
    if (m[1] !== undefined) names.push(m[1])
  }
  return names
}

/**
 * One operator-declared REST request. Becomes one namespaced MCP tool.
 *
 * Security invariants:
 *   - Every `{placeholder}` in `path` must have a matching declared `in:"path"`
 *     param, and every `in:"path"` param must appear as a placeholder — the
 *     path template and the declared params must agree exactly (mirrors CLI's
 *     argv↔args cross-check).
 *   - At most one `in:"body"` param (v1: single JSON-pass-through body value).
 */
export const HttpRequestToolSchema = z
  .object({
    /** Raw MCP tool name (namespaced by the proxy). Must match ^[a-zA-Z][a-zA-Z0-9_]*$. */
    name: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "tool name must match ^[a-zA-Z][a-zA-Z0-9_]*$"),
    /** Required, non-empty — this is the agent's only knowledge of what the tool does. */
    description: z.string().min(1),
    /** HTTP method for this request. */
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    /** Request path, e.g. "/repos/{owner}/{repo}/issues" — {placeholders} bind to `in:"path"` params. */
    path: z.string(),
    /** Declared param slots. Agent must supply required ones; optional may be absent. */
    params: z.array(HttpParamSchema).default([]),
    /** Optional hint about the response shape, forwarded to the agent. */
    responseHint: z.string().optional(),
    /** Per-tool request timeout override. Hard cap: 120s. */
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    /** Confirm-before-call hint (surfaced later; stored now). */
    confirm: z.boolean().optional(),
  })
  .refine(
    (tool) => {
      // Every {placeholder} in `path` MUST have a declared param with in:"path"
      // and that exact name; every in:"path" param MUST appear as a placeholder.
      const placeholders = pathPlaceholders(tool.path)
      const pathParams = new Set(tool.params.filter((p) => p.in === "path").map((p) => p.name))
      if (placeholders.size !== pathParams.size) return false
      for (const name of placeholders) {
        if (!pathParams.has(name)) return false
      }
      for (const name of pathParams) {
        if (!placeholders.has(name)) return false
      }
      return true
    },
    {
      message:
        'every {placeholder} in `path` must have a matching declared param with in:"path" ' +
        'and every in:"path" param must appear as a {placeholder} in `path`',
      path: ["params"],
    },
  )
  .refine((tool) => tool.params.filter((p) => p.in === "body").length <= 1, {
    message: 'at most one param with in:"body" is allowed (v1: single JSON-pass-through body)',
    path: ["params"],
  })
  // A path placeholder is STRUCTURALLY mandatory: if an in:"path" param were
  // optional and the agent omitted it, the literal "{name}" would be left in the
  // outbound URL path (a malformed request). Reject the footgun declaration at the
  // trust boundary rather than emit a broken path per-call. (inc-30.7 SSRF review.)
  .refine((tool) => tool.params.filter((p) => p.in === "path").every((p) => p.required), {
    message: 'params with in:"path" must be required (a {placeholder} is structurally mandatory)',
    path: ["params"],
  })
  // A placeholder repeated in the path (`/a/{id}/b/{id}`) can't be bound: the
  // call-time `path.replace("{id}", …)` substitutes only the FIRST occurrence,
  // leaving the rest literal. Reject at author-time. (inc-30.7 correctness review.)
  .refine(
    (tool) => {
      const list = pathPlaceholderList(tool.path)
      return list.length === new Set(list).size
    },
    {
      message:
        "a {placeholder} may appear at most once in `path` (repeated placeholders can't bind)",
      path: ["path"],
    },
  )
  // A GET/HEAD request cannot carry a body — fetch throws on every call. Reject a
  // body param on GET/HEAD at author-time, not per-call. (inc-30.7 correctness review.)
  .refine(
    (tool) =>
      !(
        (tool.method === "GET" || tool.method === "HEAD") &&
        tool.params.some((p) => p.in === "body")
      ),
    {
      message: 'a GET or HEAD request tool cannot declare an in:"body" param',
      path: ["params"],
    },
  )
  // Param names must be unique across the whole tool — a duplicate name (even
  // across different `in` locations) would bind ONE agent arg to two places and
  // collide in the generated input schema. (inc-30.7 correctness review.)
  .refine(
    (tool) => {
      const names = tool.params.map((p) => p.name)
      return names.length === new Set(names).size
    },
    { message: "param names must be unique within a request tool", path: ["params"] },
  )
  // The reserved arg key "body" belongs to the (optional) in:"body" param. A
  // NON-body param named "body" would collide with the body-stringify path (the
  // engine defaults bodyArgKey to "body" when no body param exists). Forbid it.
  // (inc-30.7 CodeRabbit #512.)
  .refine((tool) => !tool.params.some((p) => p.in !== "body" && p.name === "body"), {
    message: 'only an in:"body" param may be named "body" (reserved for the request body)',
    path: ["params"],
  })

export type HttpRequestTool = z.infer<typeof HttpRequestToolSchema>

// ---------------------------------------------------------------------------
// Connection descriptor
// ---------------------------------------------------------------------------

/**
 * User-authored REST source descriptor. Meaningful when Platform.kind === "http".
 *
 * SECURITY: the auth secret is resolved from CredentialStore at call-time and
 * injected into the outbound request ONLY — it is never stored in this
 * descriptor and never reaches a tool result, log, or error message.
 */
export const HttpConnectionSchema = z.object({
  /**
   * Host-pinned base URL. Agent args never set the host — only path/query/body
   * values. Enforced http/https at the trust boundary (z.string().url() alone
   * accepts file://, ftp://, gopher:// — reject non-http schemes at add-time
   * rather than store-then-fail-per-call; inc-30.7 SSRF review, mirrors openapi).
   */
  baseUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), { message: "baseUrl must be an http or https URL" }),
  /** How to authenticate outbound requests — reused verbatim from the OpenAPI surface. */
  auth: OpenApiAuthSchema.optional(),
  /** Extra headers added to every outbound request. */
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  /** One or more operator-declared REST requests — each becomes one namespaced MCP tool. */
  tools: z.array(HttpRequestToolSchema).min(1),
})

export type HttpConnection = z.infer<typeof HttpConnectionSchema>
