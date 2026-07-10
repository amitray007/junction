// SPDX-License-Identifier: AGPL-3.0-only
// `junction run <file.js> --profile <name>` — run agent JS (Code Mode) against
// a profile, over Slice B's @junction/code-mode engine (increment 33 Slice D).
//
// THIN EDGE: argv → build the ProfileProxy (identical sequence to `mcp serve`,
// commands/mcp.ts) → runCode (code-mode) → format. No engine logic lives here
// — the QuickJS executor, facade, audit-emit wiring (code_exec + inner
// tool_call, joined by one correlationId) all live in @junction/code-mode.
// This file only builds the ToolInvoker + AuditPrincipal + AuditSink, exactly
// as commands/mcp.ts's stdio `mcp serve` does, and reuses that construction —
// see that file's header for the ARCHITECTURE / CREDENTIAL DISCIPLINE notes,
// which apply identically here.
//
// STDOUT DISCIPLINE: this command is NOT the MCP channel (unlike `mcp serve`),
// but it still keeps stdout machine-clean for --json — the ONLY thing written
// to stdout is the final JSON envelope (or, in human mode, the pretty-printed
// result). Any interim/progress note goes to stderr via consola.

import { readFile } from "node:fs/promises"
import { runCode } from "@junction/code-mode"
import {
  type AuditPrincipal,
  createCredentialStore,
  createFileToolPinStore,
  createProfileProxy,
  createRepositories,
  ensureHome,
  getDatabase,
  getPaths,
  rotateAuditLogIfOversized,
  sweepStaleCredDirs,
} from "@junction/core"
import { makeResolveProvider } from "@junction/source-runtime"
import { defineCommand } from "citty"
import { consola } from "consola"
import { JSON_ARG } from "../args.js"
import { createFileAuditSink } from "../audit-sink.js"
import { reportError } from "../format.js"

// ---------------------------------------------------------------------------
// run command
// ---------------------------------------------------------------------------

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run agent JS (Code Mode) against a profile's brokered tools.",
  },
  args: {
    file: {
      type: "positional",
      description: "Path to the JS file to run",
      required: true,
    },
    profile: {
      type: "string",
      description: "Profile name to run against",
      required: true,
    },
    timeout: {
      type: "string",
      description: "Wall-clock timeout in milliseconds (default: code-mode's DEFAULT_EXECUTE_OPTS)",
      default: "",
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const profileName = args.profile

    // ── Optional --timeout: parse eagerly so a bad value fails before any I/O ──
    let timeoutMs: number | undefined
    if (args.timeout !== "") {
      const parsed = Number(args.timeout)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        reportError(json, `invalid --timeout "${args.timeout}" (expected a positive integer)`)
        return
      }
      timeoutMs = parsed
    }

    // ── Read the guest JS file (async — no fs.*Sync) ──────────────────────
    let code: string
    try {
      code = await readFile(args.file, "utf8")
    } catch (cause) {
      reportError(json, `failed to read "${args.file}": ${String(cause)}`)
      return
    }
    if (code.trim() === "") {
      reportError(json, `"${args.file}" is empty — nothing to run`)
      return
    }

    // ── Ensure the home dir exists at 0700 (defense-in-depth, mirrors mcp serve) ──
    const homeResult = await ensureHome()
    if (homeResult.isErr()) {
      reportError(json, `failed to create home dir (${homeResult.error.kind})`)
      return
    }

    // Fire-and-forget: sweep any stale (>1h) cred-* temp dirs stranded by a
    // hard kill mid-materialization. Never awaited into the startup path.
    void sweepStaleCredDirs(homeResult.value).catch(() => {})

    // ── Load the named profile from DB ────────────────────────────────────
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) {
      reportError(json, `database error (${dbResult.error.kind})`)
      return
    }
    const db = dbResult.value
    const repos = createRepositories(db)
    const profileResult = await repos.profiles.getByName(profileName)
    if (profileResult.isErr()) {
      if (profileResult.error.kind === "not-found") {
        reportError(json, `profile "${profileName}" not found`)
      } else {
        reportError(json, `failed to load profile "${profileName}" (${profileResult.error.kind})`)
      }
      return
    }
    const profile = profileResult.value

    // ── Open the credential store (best-effort — mirrors commands/mcp.ts) ──
    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) {
      consola.warn(
        `junction run: credential store unavailable (${storeResult.error.kind}), all sources will be skipped`,
      )
    }
    const store = storeResult.isOk() ? storeResult.value : null

    // ── Build resolveProvider (injected into the proxy) ────────────────────
    // SECURITY: the secret is fetched per-call inside resolveProvider and
    // flows only to the upstream transport — never logged, never returned,
    // and (via the audited invoker) never handed to the guest QuickJS realm.
    const resolveProvider = makeResolveProvider(repos, store, paths, {
      logPrefix: "junction run",
      log: (msg: string) => consola.warn(msg),
    })

    // ── Build the profile proxy (core) — identical sequence to `mcp serve` ──
    const toolPinStore = createFileToolPinStore(paths)
    const proxy = createProfileProxy(
      profile.sources,
      resolveProvider,
      (info) => {
        consola.warn({
          event: info.reason === "pin-drift" ? "tool_pin_drift" : "description_sanitized",
          namespace: info.namespace,
          tool: info.tool,
          strippedSuspicious: info.strippedSuspicious,
          truncated: info.truncated,
          reason: info.reason,
        })
      },
      toolPinStore,
      (info) => {
        consola.warn({ event: "tool_pin_store_degraded", op: info.op, detail: info.detail })
      },
    )

    // Rotate BEFORE the sink opens its fd (mirrors mcp.ts / serve.ts) — a
    // rotation failure never blocks the run, just a warn.
    const rotate = await rotateAuditLogIfOversized(paths.auditLogFile)
    if (rotate.kind === "failed") {
      consola.warn(`junction run: audit-log rotation failed (${rotate.code}), continuing`)
    }

    // ── Audit sink — one pino-backed file sink for this process ────────────
    const auditSink = createFileAuditSink(paths)
    // `run` is a local, single-profile invocation — same principal shape as
    // `mcp serve` (stdio), unprefixed wire names.
    const principal: AuditPrincipal = {
      kind: "stdio",
      keyId: null,
      label: null,
      profiles: [profile.name],
    }

    // A raw Ctrl-C sends no natural completion signal — without this handler
    // the last buffered audit line could be dropped. process "exit" is the
    // belt-and-suspenders backstop for any other clean-exit path.
    process.once("SIGINT", () => {
      auditSink.flushSync()
      process.exit(130)
    })
    process.once("SIGTERM", () => {
      auditSink.flushSync()
      process.exit(143)
    })
    process.on("exit", () => auditSink.flushSync())

    // ── Run the guest code (code-mode) ──────────────────────────────────────
    // safeUpstreamMessage is lazy-imported (mirrors mcp.ts/serve.ts's own lazy
    // mcp-server import) so a `junction run` invocation only pays for
    // @junction/mcp-server's load cost when it actually executes.
    const { safeUpstreamMessage } = await import("@junction/mcp-server")

    // code-mode's ToolInvoker is expressed as plain-Promise-returning
    // (types.ts's header: deliberately NOT ResultAsync, so the package avoids
    // a direct neverthrow ResultAsync type import). `ProfileProxy` returns
    // ResultAsync, which is PromiseLike but not a real Promise (no
    // catch/finally/Symbol.toStringTag) — awaiting bridges the two exactly
    // like adaptToMcpHandlers (providers.ts) already does for the MCP edge.
    const invoker = {
      listTools: async () => await proxy.listTools(),
      callTool: async (name: string, callArgs: Record<string, unknown>) =>
        await proxy.callTool(name, callArgs),
    }

    const result = await runCode(code, invoker, {
      principal,
      sink: auditSink,
      profile: profile.name,
      safeUpstreamMessage,
      prefixed: false,
      opts: timeoutMs === undefined ? undefined : { timeoutMs },
    })

    auditSink.flush()

    // ── Format the result ───────────────────────────────────────────────────
    if (result.isErr()) {
      // Executor-side failure (module load / dispose) — distinct from a
      // guest-side outcome (ExecuteResultErr, handled below as `ok:false`
      // within a successful execute()).
      reportError(json, `code-mode executor error (${result.error.kind}): ${result.error.message}`)
      return
    }

    const outcome = result.value
    if (!outcome.ok) {
      // Guest-side failure (timeout/memory/guest-error/internal) — a
      // host-stack-free, typed outcome, NOT a thrown JS error.
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: outcome.message })}\n`)
      } else {
        consola.error(`junction run: ${outcome.kind}: ${outcome.message}`)
      }
      process.exitCode = 1
      return
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          value: outcome.value,
          logs: outcome.logs,
          emitted: outcome.emitted,
          toolCallCount: outcome.toolCallCount,
        })}\n`,
      )
      return
    }

    // Direct stdout writes (not consola, which is suppressed under
    // NODE_ENV=test/non-interactive contexts — see profile.ts's identical
    // convention note) so the result is always visible to a human OR a
    // script piping non-JSON output.
    for (const line of outcome.logs) {
      process.stdout.write(`${line}\n`)
    }
    process.stdout.write(
      `ok (${String(outcome.toolCallCount)} tool call${outcome.toolCallCount === 1 ? "" : "s"}, ${String(outcome.emitted)} emit${outcome.emitted === 1 ? "" : "s"})\n`,
    )
    process.stdout.write(`${JSON.stringify(outcome.value, null, 2)}\n`)
  },
})
