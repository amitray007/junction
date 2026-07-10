// SPDX-License-Identifier: AGPL-3.0-only
// `junction mcp serve` — serve a per-profile MCP endpoint over stdio.
//
// CRITICAL: this command's stdout IS the MCP channel. Nothing may be written
// to stdout except MCP JSON-RPC frames. Any human-readable output (resolver
// notes, proxy warnings, skipped-source notices) goes to stderr ONLY.
// Do NOT use consola (which writes to stdout) anywhere in this command.
//
// ARCHITECTURE — composition root (injection):
//   cli is the app layer that wires libs together. mcp/server NEVER imports
//   mcp/client; instead, the cli builds resolveProvider (from repos + store),
//   creates the ProfileProxy (core), adapts it to McpServerHandlers,
//   and passes those handlers to createMcpServer (mcp/server). The boundary:
//     mcp/server → core only
//     mcp/client → core only
//     cli → core + mcp/server + mcp/client   (app → libs)
//
// CREDENTIAL DISCIPLINE:
//   The secret is fetched per-call inside resolveProvider, passed to
//   createMcpProvider (which injects it into the transport), and NEVER placed
//   in any tool result, MCP response, error message, stderr note, or log.
//
// DISPATCH BY KIND (increment 14/17):
//   buildProvider (providers.ts) switches on platform.kind:
//     "mcp"     → build McpToolProvider via mcp/client (lazy-imported)
//     "openapi" → build OpenApiToolProvider via openapi-client (lazy-imported)
//     other     → unsupported-source-kind error (skipped per-source gracefully)
//   Future kinds (graphql) plug in there without touching the proxy or this file.

import {
  type AuditPrincipal,
  createCredentialStore,
  createFileToolPinStore,
  createProfileProxy,
  createRepositories,
  ensureHome,
  getDatabase,
  getPaths,
  type Profile,
  ProfileIdSchema,
  rotateAuditLogIfOversized,
  sweepStaleCredDirs,
} from "@junction/core"
import { makeResolveProvider } from "@junction/source-runtime"
import { defineCommand } from "citty"
import { createFileAuditSink } from "../audit-sink.js"
import { adaptToMcpHandlers } from "../providers.js"

// ---------------------------------------------------------------------------
// Default (synthetic) profile — used when no DB is available
// ---------------------------------------------------------------------------

/** Synthetic default profile — used when no profile name is supplied or no profiles exist yet. */
function defaultProfile(): Profile {
  return {
    id: ProfileIdSchema.parse("default"),
    name: "default",
    sources: [],
  }
}

/** No-op handlers for a profile with no sources (empty tool list, all calls fail). */
function emptyHandlers() {
  return {
    listTools: () =>
      Promise.resolve({
        tools: [] as Array<{ name: string; description?: string; inputSchema: object }>,
      }),
    callTool: (_name: string, _args: Record<string, unknown>) =>
      Promise.resolve({
        isError: true as const,
        content: [{ type: "text" as const, text: "no tools available" }],
      }),
  }
}

// ---------------------------------------------------------------------------
// serve command
// ---------------------------------------------------------------------------

const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Serve a per-profile MCP endpoint over stdio.",
  },
  args: {
    profile: {
      type: "string",
      description: "Profile name to serve (defaults to 'default' if omitted or not found).",
      default: "",
    },
  },
  async run({ args }) {
    // Lazy import: mcp/server is only loaded when this command runs.
    // mcp/client and openapi-client are lazy-imported inside buildProvider (providers.ts).
    // safeUpstreamMessage is lazy-imported inside adaptToMcpHandlers (providers.ts).
    const { serveStdio } = await import("@junction/mcp-server")

    const profileName = args.profile

    // ── Ensure the home dir exists at 0700 (defense-in-depth, increment 32.1) ─
    // Placed at the TOP of run(), before the synthetic-default early-return,
    // so ANY `mcp serve` invocation — named profile or not — creates the home
    // at 0700. `init` is the only other ensureHome() caller; without this, a
    // serve-first home's dir would get mkdir'd with no mode (getDatabase),
    // landing at the umask default. Error path uses process.stderr.write, NOT
    // consola — this file's stdout IS the MCP channel (see file-level note).
    const homeResult = await ensureHome()
    if (homeResult.isErr()) {
      process.stderr.write(
        `junction mcp serve: failed to create home dir (${homeResult.error.kind})\n`,
      )
      process.exitCode = 1
      return
    }

    // Fire-and-forget: sweep any stale (>1h) cred-* temp dirs stranded by a
    // hard kill mid-materialization (increment 32.7 item 2). Placed before
    // the synthetic-default early-return so that path is swept too. `paths`
    // (getPaths()) isn't in scope until below — ensureHome() already
    // resolved to the same JunctionPaths, so use homeResult.value directly.
    // Never awaited into the startup path, never fails it.
    void sweepStaleCredDirs(homeResult.value).catch(() => {})

    // ── No profile name given: serve synthetic default immediately ──────────
    if (!profileName) {
      await serveStdio(defaultProfile(), emptyHandlers())
      return
    }

    // ── Load the named profile from DB ────────────────────────────────────
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) {
      process.stderr.write(
        `junction mcp serve: database error (${dbResult.error.kind}), serving synthetic default profile\n`,
      )
      await serveStdio(defaultProfile(), emptyHandlers())
      return
    }

    const db = dbResult.value
    const repos = createRepositories(db)
    const profileResult = await repos.profiles.getByName(profileName)

    if (profileResult.isErr()) {
      if (profileResult.error.kind === "not-found") {
        process.stderr.write(
          `junction mcp serve: profile "${profileName}" not found, serving synthetic default profile\n`,
        )
        await serveStdio(defaultProfile(), emptyHandlers())
        return
      }
      process.stderr.write(
        `junction mcp serve: failed to load profile "${profileName}" (${profileResult.error.kind})\n`,
      )
      process.exitCode = 1
      return
    }

    const profile = profileResult.value

    // ── Open the credential store ─────────────────────────────────────────
    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) {
      // Store unavailable: serve the profile but with no credential resolution.
      // All sources will fail to resolve → proxy returns empty tools.
      process.stderr.write(
        `junction mcp serve: credential store unavailable (${storeResult.error.kind}), all sources will be skipped\n`,
      )
    }
    const store = storeResult.isOk() ? storeResult.value : null

    // ── Build resolveProvider (injected into the proxy) ───────────────────
    //
    // SECURITY: resolveProvider writes stderr notes for skipped sources but NEVER
    // leaks secret values. The secret is returned in the ToolProvider's transport
    // and flows only to the upstream; it is never logged or serialized.
    //
    // Shared with `junction serve` (commands/serve.ts) via providers.ts —
    // both build the identical resolution pipeline; only the log
    // prefix/sink differs (this command writes stderr directly to keep
    // stdout pure for the MCP channel — see the file-level note above).
    const resolveProvider = makeResolveProvider(repos, store, paths, {
      logPrefix: "junction mcp serve",
    })

    // ── Build the profile proxy (core) ────────────────────────────────────
    // Tool-poisoning mitigation (increment 32.5) + hash-pinning / rug-pull detection
    // (increment 32.11): sanitize and TOFU pin-comparison are always applied inside
    // createProfileProxy; onDescriptionDrift only SURFACES either signal, discriminated
    // by info.reason ("sanitized" | "pin-drift"). stdout IS the MCP channel here
    // (file-level note above) — the drift warn goes to stderr ONLY, via
    // process.stderr.write (never consola, which writes to stdout). Metadata only —
    // never the (possibly-injected) description text, never old/new hashes.
    const toolPinStore = createFileToolPinStore(paths)
    const proxy = createProfileProxy(
      profile.sources,
      resolveProvider,
      (info) => {
        process.stderr.write(
          `${JSON.stringify({
            event: info.reason === "pin-drift" ? "tool_pin_drift" : "description_sanitized",
            namespace: info.namespace,
            tool: info.tool,
            strippedSuspicious: info.strippedSuspicious,
            truncated: info.truncated,
            reason: info.reason,
          })}\n`,
        )
      },
      toolPinStore,
    )

    // Rotate BEFORE the sink opens its fd (increment 32.8) — see rotate.ts's
    // header for the rotate-before-open design rationale. A rotation failure
    // never blocks startup; it's just a stderr warn (stdout carries the MCP
    // protocol — see the file-level note above).
    const rotate = await rotateAuditLogIfOversized(paths.auditLogFile)
    if (rotate.kind === "failed") {
      process.stderr.write(
        `junction mcp serve: audit-log rotation failed (${rotate.code}), continuing\n`,
      )
    }

    // ── Audit sink (increment 31 Slice B) ─────────────────────────────────
    // One pino-backed file sink per process. stdio is always single-profile
    // passthrough — unprefixed wire names, principal.profiles is just this
    // one profile.
    const auditSink = createFileAuditSink(paths)
    const principal: AuditPrincipal = {
      kind: "stdio",
      keyId: null,
      label: null,
      profiles: [profile.name],
    }

    // A raw Ctrl-C (SIGINT/SIGTERM) sends no stdin EOF, so serveStdio's
    // Promise below never resolves on that path — without this handler the
    // last buffered audit line would be dropped. process "exit" below is the
    // belt-and-suspenders backstop for any other clean-exit path.
    process.once("SIGINT", () => {
      auditSink.flushSync()
      process.exit(0)
    })
    process.once("SIGTERM", () => {
      auditSink.flushSync()
      process.exit(0)
    })
    process.on("exit", () => auditSink.flushSync())

    // ── Adapt proxy ResultAsync → Promise handlers for mcp/server ─────────
    // Shared with `junction serve` (commands/serve.ts) via providers.ts.
    const handlers = adaptToMcpHandlers(proxy, { principal, sink: auditSink, prefixed: false })

    // ── Serve ─────────────────────────────────────────────────────────────
    // serveStdio resolves on the CLEAN shutdown path (transport onclose /
    // stdin EOF) — flush right after it returns, the natural clean-exit point.
    await serveStdio(profile, handlers)
    auditSink.flush()
  },
})

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description: "MCP server commands.",
  },
  subCommands: {
    serve: serveCommand,
  },
})
