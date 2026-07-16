// SPDX-License-Identifier: AGPL-3.0-only
// Server-only platform mutation helpers — add/update/delete/refresh a platform.
// Called exclusively from platform-mutations.functions.ts createServerFn handlers.
// SECURITY: all output is metadata-only — no secret, no secretRef.
//
// Auth exposed at add-time (v1, pragmatic subset — see report):
//   - mcp-http:  bearer only (authHeader override, default "Authorization")
//   - mcp-stdio: no auth sub-form (credential injection stays CLI-only for now)
//   - openapi:   no-auth | bearer | apiKey (header) — basic + query/cookie apiKey deferred
//   - graphql:   no-auth | bearer | apiKey (header) — same deferral as openapi
//   - cli:       none (connection carries its own credentialEnvVar)
// Full CLI auth-flag parity (query/cookie apiKey, basic) is deferred to a future
// increment; this is a bearer-first subset, not the complete CLI surface (slice B).
//
// CLI assembly (inc 26 wave 3): the web form sends a structured CliConnectionInput
// (tools with a raw `commandLine` string + declared args + policy), NOT pre-built
// argv. This module is the ONE authoritative place that tokenizes commandLine into
// argv (via the client-safe lib/cli-command.ts tokenizer) and runs
// CliConnectionSchema.parse as the final authority before the descriptor reaches
// addCliPlatform/validatePolicy/the sandbox. Never trust a client-sent argv array.

import type {
  CliConnection,
  CliTool,
  DeclaredCliConnection,
  HttpConnection,
  Platform,
} from "@junction/core"
import {
  CliConnectionSchema,
  discoverBinary,
  HttpConnectionSchema,
  isFullAccess,
} from "@junction/core"
import {
  addCliPlatform,
  addFullAccessCliPlatform,
  addGraphQlPlatform,
  addHttpPlatform,
  addMcpPlatform,
  addOpenApiPlatform,
  refreshOpenApiPlatform,
  setFullAccessCliShortcuts,
} from "@junction/platform-orchestration"
import { errAsync, type ResultAsync } from "neverthrow"
import type { CliArgInput, CliPolicyInput } from "../lib/cli-command.js"
import { tokenizeCommandLine } from "../lib/cli-command.js"
import { withRepos } from "./shared.server.js"

// Structural shape of a Zod error's issues — avoids a direct `zod` type import
// (web has no zod dep; zod is core's boundary validator). Matches what
// CliConnectionSchema.safeParse(...).error exposes: an `issues` array of
// { path, message }. Read structurally so the web package stays zod-free.
type ZodIssueLike = { path: PropertyKey[]; message: string }
type ZodErrorLike = { issues: ZodIssueLike[] }

// ---------------------------------------------------------------------------
// Input shapes — mirror the discriminated validator output in
// platform-mutations.functions.ts exactly.
// ---------------------------------------------------------------------------

export type SimpleAuthInput =
  | { scheme: "none" }
  | { scheme: "bearer" }
  | { scheme: "apiKey"; name: string }

/** One declared arg slot on a CLI tool — the shared client-safe shape (see cli-command.ts). */
export type CliToolArgInput = CliArgInput

/** One CLI tool — the raw commandLine is tokenized server-side (authoritative). */
export interface CliToolInput {
  name: string
  description?: string
  /** Raw "Command" input text, e.g. "/opt/homebrew/bin/rg --json $pattern". */
  commandLine: string
  args: CliToolArgInput[]
  policy: CliPolicyInput
  /**
   * The guided form's JSON escape hatch: when set, this parsed tool object
   * (already-built argv + args + policy, the pre-guided-form descriptor shape)
   * is used VERBATIM instead of `commandLine`/`args`/`policy` above — for a
   * tool whose argv can't round-trip through the command-line builder (see
   * lib/cli-command.ts `isReversible`). Still re-validated by
   * CliConnectionSchema.parse below; never trusted beyond that.
   */
  advancedTool?: unknown
}

export interface CliConnectionInput {
  tools: CliToolInput[]
  credentialEnvVar?: string
}

// ---------------------------------------------------------------------------
// HTTP surface input shapes — straight field copy (no tokenizer, unlike CLI).
// HttpConnectionSchema (core) is the final authority; these are the boundary shapes.
// ---------------------------------------------------------------------------

/** One declared param on an HTTP request-tool — mirrors core's HttpParamSchema. */
export interface HttpParamInput {
  name: string
  in: "path" | "query" | "header" | "body"
  type: "string" | "number" | "boolean" | "enum"
  required: boolean
  description?: string
  enum?: string[]
  pattern?: string
  maxLength?: number
}

/** One operator-declared REST request — becomes one namespaced MCP tool. */
export interface HttpToolInput {
  name: string
  description: string
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
  path: string
  params: HttpParamInput[]
  responseHint?: string
  timeoutMs?: number
}

export interface HttpConnectionInput {
  baseUrl: string
  auth?: SimpleAuthInput
  defaultHeaders?: Record<string, string>
  tools: HttpToolInput[]
}

export type AddPlatformInput =
  | {
      kind: "mcp-http"
      id: string
      displayName: string
      url: string
      authHeader?: string
    }
  | {
      kind: "mcp-stdio"
      id: string
      displayName: string
      command: string
      args?: string[]
      tokenEnvVar?: string
      /** Static env vars for the child MCP server — passed straight through to addMcpPlatform. */
      env?: Record<string, string>
    }
  | {
      kind: "openapi"
      id: string
      displayName: string
      specUrl: string
      baseUrl?: string
      auth?: SimpleAuthInput
      /**
       * Operator-designated verify operationId (increment 28.9) — must resolve
       * to a GET with no required parameters in the parsed spec; validated by
       * addOpenApiPlatform/refreshOpenApiPlatform before persisting. Absent ⇒
       * the platform stays honestly "not-verifiable" for verify-on-add/test.
       */
      verifyOperationId?: string
    }
  | {
      kind: "graphql"
      id: string
      displayName: string
      endpoint: string
      auth?: SimpleAuthInput
    }
  | {
      kind: "cli"
      id: string
      displayName: string
      connection: CliConnectionInput
    }
  | {
      kind: "http"
      id: string
      displayName: string
      connection: HttpConnectionInput
    }

/** Update = add's per-kind shape plus the existing platform's id. */
export type UpdatePlatformInput = AddPlatformInput

export type PlatformMetaResult =
  | { ok: true; platform: { id: string; kind: string; displayName: string; baseUrl?: string } }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

// ---------------------------------------------------------------------------
// Human-readable error messages for orchestration + DB error kinds.
// ---------------------------------------------------------------------------

function orchestrationErrorMessage(e: { kind: string; [k: string]: unknown }): string {
  switch (e.kind) {
    case "invalid-transport":
      return `Invalid transport "${e.transport}"`
    case "missing-field":
      return `Missing required field "${e.field}" for ${e.context}`
    case "spec-fetch-failed":
      return "Failed to fetch the spec — check the URL and network access"
    case "spec-parse-failed":
      return "Failed to parse the spec — it may not be valid OpenAPI/GraphQL SDL"
    case "too-many-tools":
      return `Spec exposes ${e.count} tools, over the cap of ${e.cap} — narrow with a tag/path selection`
    case "extract-failed":
      return "Failed to extract tools from the spec"
    case "base-url":
      return e.reason === "base-url-has-variables"
        ? "Spec's server URL has unresolved template variables — provide an explicit base URL"
        : "Could not determine a base URL — provide one explicitly"
    case "invalid-connection":
      return `Invalid connection: ${e.message}`
    case "invalid-platform":
      return `Invalid platform: ${e.message}`
    case "apikey-in-query-unsupported":
      return "API key in query is not supported for GraphQL — use a header instead"
    case "invalid-descriptor":
      return `Invalid descriptor: ${e.message}`
    case "policy-invalid":
      return `Policy invalid for tool "${e.toolName}": ${e.reason}`
    case "spec-cache-failed":
      return "Failed to cache the spec locally"
    case "not-openapi":
      return "Only OpenAPI platforms can be refreshed"
    case "not-url-spec":
      return "Only specs added from a URL can be refreshed"
    case "verify-op-invalid":
      return `Invalid verify operation: ${e.message}`
    case "full-access-not-yet-supported":
      return "Full CLI access platforms aren't added via a raw descriptor — use the discovery install flow"
    case "invalid-binary-name":
      return `"${e.name}" is not a valid bare command name`
    case "binary-not-found":
      return `Could not find "${e.name}" on PATH or in common install dirs — enter the path manually`
    case "binary-path-invalid":
      return `Binary path is invalid: ${e.reason}`
    case "sandbox-unavailable":
      return "No sandbox backend available on this host — Full CLI access install requires one to extract the command schema"
    case "extract-refused":
      return `Sandbox refused to run "--help" against the pinned binary: ${String(e.cause)}`
    case "not-full-access":
      return `Shortcuts can only be set on a Full CLI access platform (this platform is kind "${e.platformKind}")`
    default:
      return "Operation failed"
  }
}

export function dbErrorMessage(kind: string): string {
  switch (kind) {
    case "not-found":
      return "Platform not found"
    case "in-use":
      return "Platform is in use by one or more credentials or sources; remove those first"
    case "constraint-violation":
      return "A platform with that id already exists"
    case "query-failed":
      return "Database error"
    default:
      return "Operation failed"
  }
}

/** Map a ZodError's issues to a flat field-name → message record for the UI. */
function zodFieldErrors(error: ZodErrorLike): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_root"
    // First message per field wins — enough for inline field-level display.
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

/**
 * Shared tail for the connection assemblers: run a Zod safeParse result into the
 * `{ ok:true, connection } | { ok:false, message, fieldErrors }` shape every
 * assembleXConnection returns (cli + http; the safeParse→ZodError→fieldErrors
 * mapping was identical in both). The caller owns building the raw object per
 * kind; this owns only the validate-and-shape step.
 */
function finishAssemble<T>(
  parsed: { success: true; data: T } | { success: false; error: { issues: ZodIssueLike[] } },
):
  | { ok: true; connection: T }
  | { ok: false; message: string; fieldErrors: Record<string, string> } {
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((i) => i.message).join(", "),
      fieldErrors: zodFieldErrors(parsed.error as ZodErrorLike),
    }
  }
  return { ok: true, connection: parsed.data }
}

function toPlatformMeta(p: Platform): PlatformMetaResult & { ok: true } {
  return {
    ok: true,
    platform: {
      id: String(p.id),
      kind: p.kind,
      displayName: p.displayName,
      ...(p.openapi?.baseUrl !== undefined ? { baseUrl: p.openapi.baseUrl } : {}),
    },
  }
}

/** The bare {id, kind, displayName} shape every non-openapi upsert success reports. */
function toBarePlatformMeta(p: Platform): { id: string; kind: string; displayName: string } {
  return { id: String(p.id), kind: p.kind, displayName: p.displayName }
}

/**
 * Shared tail for the three call sites that upsert an already-assembled Platform
 * and report either a DB error or a caller-shaped success value: declared/http/mcp/
 * openapi/graphql add+update (assembleAndUpsert), Full CLI access install
 * (mutateAddFullAccessCliPlatform), and Full CLI access shortcuts editing
 * (mutateSetFullAccessCliShortcuts). `onSuccess` shapes the persisted Platform into
 * each caller's own result type (they differ: install adds nodeCount/truncated,
 * shortcuts editing adds nothing extra, assembleAndUpsert uses toPlatformMeta's
 * baseUrl-inclusive shape) — only the upsert-and-map-DB-error plumbing is shared.
 */
function upsertAndReport<T extends { ok: true }>(
  platform: Platform,
  onSuccess: (persisted: Platform) => T,
): Promise<T | { ok: false; error: string }> {
  return withRepos(async (repos) => {
    const upsertResult = await repos.platforms.upsert(platform)
    if (upsertResult.isErr()) {
      return { ok: false as const, error: dbErrorMessage(upsertResult.error.kind) }
    }
    return onSuccess(upsertResult.value)
  })
}

// ---------------------------------------------------------------------------
// Auth mapping — SimpleAuthInput (web's bearer-first subset) → orchestration AuthInput
// ---------------------------------------------------------------------------

function toAuthInput(
  auth: SimpleAuthInput | undefined,
): { scheme?: "apiKey" | "bearer" | "basic"; in?: "header"; name?: string } | undefined {
  if (!auth || auth.scheme === "none") return undefined
  if (auth.scheme === "bearer") return { scheme: "bearer" }
  return { scheme: "apiKey", in: "header", name: auth.name }
}

// ---------------------------------------------------------------------------
// CLI assembly — the ONE authoritative client-input → CliConnection transform.
// ---------------------------------------------------------------------------

/**
 * Map one web CliToolInput (raw commandLine + args + policy) to the raw object
 * shape CliConnectionSchema/CliToolSchema expects — re-tokenizing commandLine
 * server-side (never trusting a client argv) and mapping policy.network →
 * allowNet. Shared by the declared-mode connection assembler (assembleCliConnection)
 * AND the full-access shortcuts assembler (assembleCliShortcuts, inc 41.5) —
 * both build a `CliTool[]`, just destined for a different field
 * (connection.tools vs connection.shortcuts).
 */
function toRawCliTool(tool: CliToolInput): unknown {
  // The JSON escape hatch: use the operator's raw tool object verbatim
  // (CliConnectionSchema.parse below is still the final authority).
  if (tool.advancedTool !== undefined) return tool.advancedTool
  /* jscpd:ignore-start — mirrors the CliTool arg/policy field shape that the
     client-side cli-form/convert.ts also maps (client→wire) and that core's
     CliConnectionSchema defines. It can't be factored to a shared module (the
     client form file must not import server/core), so this structural mirror
     across the client↔server boundary is permitted per the DRY policy. */
  return {
    name: tool.name,
    description: tool.description,
    argv: tokenizeCommandLine(tool.commandLine),
    args: tool.args.map((a) => ({
      name: a.name,
      description: a.description,
      type: a.type,
      required: a.required,
      enum: a.enum,
      pattern: a.pattern,
      maxLength: a.maxLength,
    })),
    policy: {
      cwd: tool.policy.cwd,
      readPaths: tool.policy.readPaths,
      writePaths: tool.policy.writePaths,
      allowNet: tool.policy.network.mode === "allow" ? tool.policy.network.hosts : [],
      timeoutMs: tool.policy.timeoutMs,
      envAllow: tool.policy.envAllow,
    },
  } /* jscpd:ignore-end */
}

/**
 * Assemble+validate a CliConnection from the web's structured CliConnectionInput.
 * Re-tokenizes each tool's raw commandLine server-side (never trusts a client
 * argv) and maps policy.network → allowNet, then runs CliConnectionSchema.parse
 * as the final authority. Returns either the validated CliConnection or a
 * {message, fieldErrors} pair derived from the ZodError.
 */
function assembleCliConnection(
  input: CliConnectionInput,
):
  | { ok: true; connection: CliConnection }
  | { ok: false; message: string; fieldErrors: Record<string, string> } {
  const raw = {
    tools: input.tools.map(toRawCliTool),
    ...(input.credentialEnvVar ? { credentialEnvVar: input.credentialEnvVar } : {}),
  }

  return finishAssemble(CliConnectionSchema.safeParse(raw))
}

// ---------------------------------------------------------------------------
// HTTP assembly — straight field copy (no tokenizer, unlike CLI: HTTP has no
// argv/command-line to reconstruct). HttpConnectionSchema.safeParse is the
// final authority, same ZodError → {message, fieldErrors} mapping as CLI.
// ---------------------------------------------------------------------------

function assembleHttpConnection(
  input: HttpConnectionInput,
):
  | { ok: true; connection: HttpConnection }
  | { ok: false; message: string; fieldErrors: Record<string, string> } {
  const raw = {
    baseUrl: input.baseUrl,
    ...(input.auth ? { auth: toAuthInput(input.auth) } : {}),
    ...(input.defaultHeaders ? { defaultHeaders: input.defaultHeaders } : {}),
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      method: tool.method,
      path: tool.path,
      params: tool.params.map((p) => ({
        name: p.name,
        in: p.in,
        type: p.type,
        required: p.required,
        description: p.description,
        enum: p.enum,
        pattern: p.pattern,
        maxLength: p.maxLength,
      })),
      responseHint: tool.responseHint,
      timeoutMs: tool.timeoutMs,
    })),
  }

  return finishAssemble(HttpConnectionSchema.safeParse(raw))
}

// ---------------------------------------------------------------------------
// Full CLI access — binary discovery + install (inc 41.4).
// docs/specs/2026-07-16-cli-exploratory-mode.md §5 Q1/Q3/Q6.
// ---------------------------------------------------------------------------

/** One candidate binary — metadata only (path/version/source), no I/O detail leaked. */
export type CliBinaryCandidate = {
  path: string
  realpath: string
  version?: string
  source: "path" | "common-dir"
}

export type DiscoverCliBinaryResult =
  | { ok: true; candidates: CliBinaryCandidate[] }
  | { ok: false; error: string }

/**
 * Discover candidate binaries for a bare command name — the web install
 * picker's data source. Never execs unsandboxed (discoverBinary's own
 * contract); this wrapper adds no sandbox here since the version probe is
 * best-effort and optional — a version-less candidate list is still useful,
 * and threading a full sandbox instance through the picker step only for
 * `--version` isn't worth the extra createSandbox() cost on every keystroke.
 * The install step (mutateAddFullAccessCliPlatform) DOES use the sandbox —
 * that's where extraction actually runs.
 */
export async function discoverCliBinary(name: string): Promise<DiscoverCliBinaryResult> {
  const result = await discoverBinary(name)
  if (result.isErr()) {
    return { ok: false, error: `"${name}" is not a valid bare command name` }
  }
  return {
    ok: true,
    candidates: result.value.map((c) => ({
      path: c.path,
      realpath: c.realpath,
      ...(c.version !== undefined ? { version: c.version } : {}),
      source: c.source,
    })),
  }
}

export interface AddFullAccessCliPlatformInput {
  id: string
  displayName: string
  /** The chosen candidate's realpath (from discoverCliBinary) or a manual override. */
  binaryPath: string
  credentialEnvVar?: string
  /** host:port allowlist entries. Empty/absent = no network (safe default). */
  allowNet?: string[]
}

export type AddFullAccessCliPlatformResult =
  | {
      ok: true
      platform: { id: string; kind: string; displayName: string }
      nodeCount: number
      truncated: boolean
    }
  | { ok: false; error: string }

/**
 * Install a Full CLI access platform: run extractCliSchema (sandboxed) against
 * the pinned binaryPath and upsert the resulting platform. Distinct from
 * mutateAddPlatform's declared-mode dispatch — Full CLI access has no
 * CliConnectionInput form shape (no tools/args to assemble), just a resolved
 * binary + optional credential env var + optional net allowlist.
 */
export async function mutateAddFullAccessCliPlatform(
  input: AddFullAccessCliPlatformInput,
): Promise<AddFullAccessCliPlatformResult> {
  const addResult = await addFullAccessCliPlatform({
    id: input.id,
    displayName: input.displayName,
    binaryPath: input.binaryPath,
    ...(input.credentialEnvVar ? { credentialEnvVar: input.credentialEnvVar } : {}),
    ...(input.allowNet && input.allowNet.length > 0 ? { allowNet: input.allowNet } : {}),
  })
  if (addResult.isErr()) {
    return { ok: false, error: orchestrationErrorMessage(addResult.error) }
  }
  const { platform, nodeCount, truncated } = addResult.value

  return upsertAndReport(platform, (persisted) => ({
    ok: true as const,
    platform: toBarePlatformMeta(persisted),
    nodeCount,
    truncated,
  }))
}

// ---------------------------------------------------------------------------
// Full CLI access — shortcuts editing (inc 41.5). Named saved commands (the
// demoted declared-CliTool model) that ride connection.shortcuts[] on a
// Full CLI access platform, alongside execute/help. A SEPARATE path from
// updatePlatformFn: full-access has no binaryPath/policy/schema form fields
// to resubmit, so editing shortcuts must not go through the full
// assembleAndUpsert rebuild that mutateUpdatePlatform uses for every other kind.
// ---------------------------------------------------------------------------

export interface SetFullAccessCliShortcutsInput {
  id: string
  shortcuts: CliToolInput[]
}

export type SetFullAccessCliShortcutsResult =
  | { ok: true; platform: { id: string; kind: string; displayName: string } }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

/**
 * Assemble+validate a bare CliTool[] from the web's structured CliToolInput[]
 * (the same per-tool shape declared-mode tools use). Wraps each raw tool in a
 * throwaway single-tool CliConnectionSchema parse so the exact same
 * refine()s (argv[0] absolute + metachar-clean, undeclared-arg guard, etc.)
 * that gate a declared tool also gate a shortcut — CliToolSchema itself isn't
 * exported standalone, and re-deriving its refines here would drift from the
 * authoritative schema in cli-connection.ts.
 */
function assembleCliShortcuts(
  tools: CliToolInput[],
):
  | { ok: true; shortcuts: CliTool[] }
  | { ok: false; message: string; fieldErrors: Record<string, string> } {
  const shortcuts: CliTool[] = []
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]
    if (!tool) continue
    const raw = { tools: [toRawCliTool(tool)] }
    const parsed = CliConnectionSchema.safeParse(raw)
    if (!parsed.success) {
      // Re-key field errors under this shortcut's index (the throwaway parse
      // always reports "tools[0].…"; rewrite to "shortcuts[i].…" for the caller).
      const fieldErrors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const path = issue.path
          .map(String)
          .join(".")
          .replace(/^tools\.0\./, `shortcuts.${i}.`)
        const key = path || "_root"
        if (!(key in fieldErrors)) fieldErrors[key] = issue.message
      }
      return {
        ok: false,
        message: parsed.error.issues.map((iss) => iss.message).join(", "),
        fieldErrors,
      }
    }
    const [validated] = (parsed.data as DeclaredCliConnection).tools
    if (validated) shortcuts.push(validated)
  }
  return { ok: true, shortcuts }
}

/**
 * Replace a Full CLI access platform's shortcuts[] wholesale. Fetches the
 * existing platform, assembles+validates the new CliTool[] from the web's
 * structured input, delegates the field replacement + full-access guard to
 * @junction/platform-orchestration's setFullAccessCliShortcuts, then upserts.
 */
export async function mutateSetFullAccessCliShortcuts(
  input: SetFullAccessCliShortcutsInput,
): Promise<SetFullAccessCliShortcutsResult> {
  const assembled = assembleCliShortcuts(input.shortcuts)
  if (!assembled.ok) {
    return { ok: false, error: assembled.message, fieldErrors: assembled.fieldErrors }
  }

  const existing = await withRepos(async (repos) => repos.platforms.get(input.id))
  if (existing.isErr()) {
    return { ok: false, error: dbErrorMessage(existing.error.kind) }
  }

  const updateResult = setFullAccessCliShortcuts({
    platform: existing.value,
    shortcuts: assembled.shortcuts,
  })
  if (updateResult.isErr()) {
    return { ok: false, error: orchestrationErrorMessage(updateResult.error) }
  }

  return upsertAndReport(updateResult.value, (persisted) => ({
    ok: true as const,
    platform: toBarePlatformMeta(persisted),
  }))
}

// ---------------------------------------------------------------------------
// Dispatch: add a platform by kind, upsert on success.
// ---------------------------------------------------------------------------

function addByKind(
  input: AddPlatformInput,
): ResultAsync<
  { platform: Platform; sandboxWarning?: string },
  { kind: string; fieldErrors?: Record<string, string>; [k: string]: unknown }
> {
  switch (input.kind) {
    case "mcp-http":
      return addMcpPlatform({
        id: input.id,
        displayName: input.displayName,
        transport: "http",
        url: input.url,
        authHeader: input.authHeader,
      }).map((platform) => ({ platform }))
    case "mcp-stdio":
      return addMcpPlatform({
        id: input.id,
        displayName: input.displayName,
        transport: "stdio",
        command: input.command,
        args: input.args,
        tokenEnvVar: input.tokenEnvVar,
        env: input.env,
      }).map((platform) => ({ platform }))
    case "openapi":
      return addOpenApiPlatform({
        id: input.id,
        displayName: input.displayName,
        specUrl: input.specUrl,
        baseUrl: input.baseUrl,
        auth: toAuthInput(input.auth),
        verifyOperationId: input.verifyOperationId,
      }).map(({ platform }) => ({ platform }))
    case "graphql":
      return addGraphQlPlatform({
        id: input.id,
        displayName: input.displayName,
        endpoint: input.endpoint,
        auth: toAuthInput(input.auth),
      }).map(({ platform }) => ({ platform }))
    case "cli": {
      const assembled = assembleCliConnection(input.connection)
      if (!assembled.ok) {
        return errAsync({
          kind: "invalid-descriptor",
          message: assembled.message,
          fieldErrors: assembled.fieldErrors,
        })
      }
      return addCliPlatform({
        id: input.id,
        displayName: input.displayName,
        descriptor: assembled.connection,
      }).map(({ platform, sandboxWarning }) => ({ platform, sandboxWarning }))
    }
    case "http": {
      const assembled = assembleHttpConnection(input.connection)
      if (!assembled.ok) {
        return errAsync({
          kind: "invalid-descriptor",
          message: assembled.message,
          fieldErrors: assembled.fieldErrors,
        })
      }
      return addHttpPlatform({
        id: input.id,
        displayName: input.displayName,
        descriptor: assembled.connection,
      }).map(({ platform }) => ({ platform }))
    }
  }
}

/**
 * Assemble a Platform from the per-kind input (addByKind) and upsert it, mapping
 * orchestration + DB errors to the metadata-only result. Shared by add + update
 * (update is a full rebuild through the same path — it just existence-checks first).
 */
async function assembleAndUpsert(input: AddPlatformInput): Promise<PlatformMetaResult> {
  const addResult = await addByKind(input)
  if (addResult.isErr()) {
    const e = addResult.error
    return {
      ok: false,
      error: orchestrationErrorMessage(e),
      ...(e.fieldErrors ? { fieldErrors: e.fieldErrors as Record<string, string> } : {}),
    }
  }
  const { platform } = addResult.value

  return upsertAndReport(platform, toPlatformMeta)
}

/**
 * Add a platform of any kind. Dispatches to the matching orchestration add* fn,
 * then upserts the resulting Platform. Returns metadata-only shape.
 */
export async function mutateAddPlatform(input: AddPlatformInput): Promise<PlatformMetaResult> {
  return assembleAndUpsert(input)
}

/**
 * Update a platform's full connection — a rebuild, not a patch. Dispatches
 * through the SAME per-kind addByKind assembly used by add (openapi/graphql
 * re-fetch/re-introspect on every edit, matching add semantics exactly — this
 * is intentional: correctness over cleverness, no stale-field risk), then
 * upserts. `input` carries the existing platform's `id`, so the upsert
 * replaces the row in place (platforms.upsert is create-or-replace-by-id).
 *
 * No displayName-only fast path: the brief allows one as optional, but a
 * two-path implementation doubles the surface for the same bug class this
 * increment exists to fix (stale connection fields) for a marginal win (skip
 * a spec fetch on a pure rename) — the full-rebuild path is simple, uniform,
 * and honest. If spec-refetch-on-rename proves too slow/flaky in practice,
 * add the fast path as a follow-up with its own test, not silently here.
 */
export async function mutateUpdatePlatform(
  input: UpdatePlatformInput,
): Promise<PlatformMetaResult> {
  // Edit must not silently CREATE: upsert alone would insert a brand-new row for an
  // unknown id. Verify the platform exists first, so editing a nonexistent id is a
  // clean not-found rather than an accidental add.
  const existing = await withRepos(async (repos) => repos.platforms.get(input.id))
  if (existing.isErr()) {
    return { ok: false, error: dbErrorMessage(existing.error.kind) }
  }

  // Full rebuild through the shared assemble+upsert path (same as add).
  return assembleAndUpsert(input)
}

/**
 * Delete a platform by id. Fails with a clean message when a FK RESTRICT fires
 * (credentials or source_refs still reference it) — matches the CLI's remove semantics.
 */
export async function mutateDeletePlatform(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withRepos(async (repos) => {
    const result = await repos.platforms.delete(id)
    if (result.isErr()) {
      return { ok: false as const, error: dbErrorMessage(result.error.kind) }
    }
    return { ok: true as const }
  })
}

/**
 * Refresh an OpenAPI platform's spec. Non-openapi platforms are rejected before
 * calling the orchestration fn (a clearer message than letting refreshOpenApiPlatform's
 * not-openapi error surface, though that path is also covered).
 */
export async function mutateRefreshPlatform(
  id: string,
): Promise<
  | { ok: true; oldCount: number | null; newCount: number; zeroToolsWarning?: string }
  | { ok: false; error: string }
> {
  return withRepos(async (repos) => {
    const getResult = await repos.platforms.get(id)
    if (getResult.isErr()) {
      return { ok: false as const, error: dbErrorMessage(getResult.error.kind) }
    }
    const platform = getResult.value
    if (platform.kind !== "openapi") {
      return { ok: false as const, error: "Only OpenAPI platforms can be refreshed" }
    }

    const refreshResult = await refreshOpenApiPlatform({ platform })
    if (refreshResult.isErr()) {
      return { ok: false as const, error: orchestrationErrorMessage(refreshResult.error) }
    }
    const { platform: updated, oldCount, newCount, zeroToolsWarning } = refreshResult.value

    const upsertResult = await repos.platforms.upsert(updated)
    if (upsertResult.isErr()) {
      return { ok: false as const, error: dbErrorMessage(upsertResult.error.kind) }
    }
    return {
      ok: true as const,
      oldCount,
      newCount,
      ...(zeroToolsWarning ? { zeroToolsWarning } : {}),
    }
  })
}

// ---------------------------------------------------------------------------
// getPlatformDetail — metadata-only DTO for pre-filling the Edit dialog.
// ---------------------------------------------------------------------------

export interface PlatformDetail {
  id: string
  kind: string
  displayName: string
  // mcp
  transport?: "http" | "stdio"
  url?: string
  hasAuthHeader?: boolean
  authHeaderName?: string
  command?: string
  args?: string[]
  hasTokenEnvVar?: boolean
  tokenEnvVarName?: string
  /** Static env vars declared on an mcp-stdio connection (non-secret; pre-fills the env-var list). */
  env?: Record<string, string>
  // openapi
  specUrl?: string
  baseUrl?: string
  authScheme?: "none" | "bearer" | "apiKey"
  authHeaderOrName?: string
  /** Operator-designated verify operationId (28.9) — pre-fills the edit form's field. */
  verifyOperationId?: string
  // graphql
  endpoint?: string
  // cli
  /**
   * "declared" (default) | "full-access" — which CliConnection branch this
   * platform's `cli` is. Declared mode's `cliTools` below are its `tools[]`
   * (mandatory, at least one); full-access mode's `cliTools` are its optional
   * `shortcuts[]` (the 41.5 editing surface persists through a SEPARATE path —
   * setFullAccessCliShortcutsFn — never updatePlatformFn, since full-access has
   * no binaryPath/policy/schema form fields to round-trip).
   */
  cliMode?: "declared" | "full-access"
  cliTools?: Array<{
    name: string
    description?: string
    commandLine: string
    args: CliToolArgInput[]
    policy: {
      cwd: string
      readPaths: string[]
      writePaths: string[]
      network: { mode: "denied" } | { mode: "allow"; hosts: string[] }
      timeoutMs: number
      envAllow: Record<string, string>
    }
    reversible: boolean
    /** Only present when !reversible — the raw tool JSON for the per-tool JSON escape hatch. */
    rawJson?: string
  }>
  cliCredentialEnvVar?: string
  // http (baseUrl/authScheme/authHeaderOrName shared with openapi above)
  httpDefaultHeaders?: Record<string, string>
  httpTools?: Array<{
    name: string
    description: string
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
    path: string
    params: Array<{
      name: string
      in: "path" | "query" | "header" | "body"
      type: "string" | "number" | "boolean" | "enum"
      required: boolean
      description?: string
      enum?: string[]
      pattern?: string
      maxLength?: number
    }>
    responseHint?: string
    timeoutMs?: number
  }>
}

export type PlatformDetailResult =
  | { ok: true; detail: PlatformDetail }
  | { ok: false; error: string }

/**
 * Fetch a single platform's connection details for pre-filling the Edit dialog.
 * CRITICAL: metadata-only — explicitly maps only the fields the guided forms
 * need. Never spreads the raw core Platform (a future core field addition must
 * not leak through this DTO by accident). No secretRef/secret ever appear here
 * — the platform row itself never stores a secret (secrets live in the
 * separate credential store).
 */
export async function getPlatformDetail(id: string): Promise<PlatformDetailResult> {
  return withRepos(async (repos) => {
    const result = await repos.platforms.get(id)
    if (result.isErr()) {
      return { ok: false as const, error: dbErrorMessage(result.error.kind) }
    }
    return { ok: true as const, detail: toPlatformDetail(result.value) }
  })
}

function toPlatformDetail(p: Platform): PlatformDetail {
  const base: PlatformDetail = { id: String(p.id), kind: p.kind, displayName: p.displayName }

  if (p.kind === "mcp" && p.connection) {
    if (p.connection.transport === "http") {
      const auth = p.connection.auth
      // auth is a discriminated union (bearer | header, inc 28.9) — bearer
      // carries `header` (the HTTP header name), header carries `name`
      // (same meaning: which header the value rides in). Web's bearer-first
      // subset only ever produces scheme:"bearer" today; "header" platforms
      // added via CLI still round-trip here for read (detail view).
      const authHeaderName =
        auth === undefined ? undefined : auth.scheme === "bearer" ? auth.header : auth.name
      return {
        ...base,
        transport: "http",
        url: p.connection.url,
        hasAuthHeader: auth !== undefined,
        authHeaderName,
      }
    }
    return {
      ...base,
      transport: "stdio",
      command: p.connection.command,
      args: p.connection.args,
      hasTokenEnvVar: p.connection.tokenEnvVar !== undefined,
      tokenEnvVarName: p.connection.tokenEnvVar,
      ...(p.connection.env ? { env: p.connection.env } : {}),
    }
  }

  if (p.kind === "openapi" && p.openapi) {
    const auth = p.openapi.auth
    return {
      ...base,
      specUrl: p.openapi.spec.from === "url" ? p.openapi.spec.url : undefined,
      baseUrl: p.openapi.baseUrl,
      authScheme: auth === undefined ? "none" : auth.scheme === "apiKey" ? "apiKey" : "bearer",
      authHeaderOrName:
        auth?.scheme === "apiKey" ? auth.name : auth?.scheme === "bearer" ? auth.header : undefined,
      verifyOperationId: p.openapi.verifyOperationId,
    }
  }

  if (p.kind === "graphql" && p.graphql) {
    const auth = p.graphql.auth
    return {
      ...base,
      endpoint: p.graphql.endpoint,
      authScheme: auth === undefined ? "none" : auth.scheme === "apiKey" ? "apiKey" : "bearer",
      authHeaderOrName:
        auth?.scheme === "apiKey" ? auth.name : auth?.scheme === "bearer" ? auth.header : undefined,
    }
  }

  if (p.kind === "cli" && p.cli) {
    // Declared platforms expose `tools`; full-access platforms expose optional
    // `shortcuts` (same CliTool shape) — `cliMode` tells the edit form which
    // persistence path a save must take (updatePlatformFn for declared,
    // setFullAccessCliShortcutsFn for full-access; see cli-form/convert.ts).
    const cliTools = isFullAccess(p.cli) ? (p.cli.shortcuts ?? []) : p.cli.tools
    return {
      ...base,
      cliMode: isFullAccess(p.cli) ? ("full-access" as const) : ("declared" as const),
      cliTools: cliTools.map((tool) => {
        const reversible = toolIsReversible(tool)
        return {
          name: tool.name,
          description: tool.description,
          commandLine: reversible ? argvToCommandLineLocal(tool.argv) : "",
          args: tool.args.map((a) => ({
            name: a.name,
            description: a.description,
            type: a.type,
            required: a.required,
            enum: a.enum,
            pattern: a.pattern,
            maxLength: a.maxLength,
          })),
          policy: {
            cwd: tool.policy.cwd,
            readPaths: tool.policy.readPaths,
            writePaths: tool.policy.writePaths,
            network:
              tool.policy.allowNet.length > 0
                ? { mode: "allow" as const, hosts: tool.policy.allowNet }
                : { mode: "denied" as const },
            timeoutMs: tool.policy.timeoutMs,
            envAllow: tool.policy.envAllow ?? {},
          },
          reversible,
          ...(reversible ? {} : { rawJson: JSON.stringify(tool, null, 2) }),
        }
      }),
      cliCredentialEnvVar: p.cli.credentialEnvVar,
    }
  }

  if (p.kind === "http" && p.http) {
    const auth = p.http.auth
    return {
      ...base,
      baseUrl: p.http.baseUrl,
      authScheme: auth === undefined ? "none" : auth.scheme === "apiKey" ? "apiKey" : "bearer",
      authHeaderOrName:
        auth?.scheme === "apiKey" ? auth.name : auth?.scheme === "bearer" ? auth.header : undefined,
      httpDefaultHeaders: p.http.defaultHeaders,
      httpTools: p.http.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        method: tool.method,
        path: tool.path,
        params: tool.params.map((param) => ({
          name: param.name,
          in: param.in,
          type: param.type,
          required: param.required,
          description: param.description,
          enum: param.enum,
          pattern: param.pattern,
          maxLength: param.maxLength,
        })),
        responseHint: tool.responseHint,
        timeoutMs: tool.timeoutMs,
      })),
    }
  }

  return base
}

// Local re-implementations of the lib/cli-command.ts helpers against the REAL
// core CliTool/CliArgvSegment shape (structurally identical to the local type
// lib/cli-command.ts declares) — reuse the same pure functions by importing them,
// since core's CliArgvSegment is structurally assignable to the lib's local type.
import { argvToCommandLine, isReversible } from "../lib/cli-command.js"

function argvToCommandLineLocal(argv: DeclaredCliConnection["tools"][number]["argv"]): string {
  return argvToCommandLine(argv)
}

function toolIsReversible(tool: DeclaredCliConnection["tools"][number]): boolean {
  return isReversible({ argv: tool.argv, args: tool.args })
}
