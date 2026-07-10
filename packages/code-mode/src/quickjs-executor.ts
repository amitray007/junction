// SPDX-License-Identifier: AGPL-3.0-only
// QuickJsExecutor — the CodeExecutor implementation: in-process QuickJS-WASM
// (asyncify variant), a fresh QuickJSAsyncRuntime + QuickJSAsyncContext PER
// execute() call.
//
// GUEST HAS ZERO AMBIENT AUTHORITY (hard invariant): only `tools`, `console`,
// and `emit` are installed on the guest global. No fetch/XHR/WebSocket, no
// process/require/import, no fs/env — DefaultIntrinsics ships Date/JSON/etc
// but no host I/O (see the method file's "Do NOT" list).
//
// EVERY WASM HANDLE IN A Scope/using (the #1 correctness trap — a leaked
// handle makes context.dispose() throw, which is the deliberate leak
// signature Slice E's handle-leak regression test relies on).
//
// NULL-PROTOTYPE MARSHALING both directions (prototype-pollution guard):
// args/results cross the FFI as JSON text, re-parsed via safeJsonParse
// (a reviver that strips `__proto__` keys) before becoming a JS object on
// either side.
//
// HOST↔GUEST BRIDGE: `newFunction` (sync) + `context.newPromise()` deferred,
// NOT `newAsyncifiedFunction`. This is load-bearing and was reached only
// after extensive empirical testing (see docs/futures/gotchas.md): the
// asyncify-suspend bridge (`newAsyncifiedFunction`) reliably corrupts the
// QuickJS runtime (GC ref-count assertions / WASM memory-out-of-bounds on
// dispose) on the SECOND-OR-LATER sequential call to the SAME asyncified
// function within one execution — reproduced identically across
// quickjs-emscripten-core 0.29.2/0.31.0/0.32.0 and every guest-code shape
// tried (async IIFE, module-mode top-level await, bare call, `.then()`
// chain, `Promise.all`). A SYNC `newFunction` that creates a
// `QuickJSDeferredPromise`, kicks off the real host async work, and
// resolves/rejects the deferred later — driven by a host-side poll loop
// that yields to the Node event loop and calls `runtime.executePendingJobs`
// each iteration — has ZERO asyncify suspend/resume involved and is stable
// under N=100 sequential calls (verified). The `variant` package therefore
// no longer needs "asyncify" specifically (a sync module would work
// equally), but the asyncify build is still what's pinned/tested; changing
// the variant is out of scope for this fix.

import variant from "@jitl/quickjs-singlefile-mjs-release-asyncify"
import type { AuditPrincipal, AuditSink, UpstreamError } from "@junction/core"
import { emitCodeExec } from "@junction/core"
import { err, ok, type Result } from "neverthrow"
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncWASMModule,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  Scope,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core"
import { type AuditedInvoker, createAuditedInvoker } from "./audited-invoker.js"
import { buildFacadePlan, describeFacadeTool, type FacadePlan, searchFacade } from "./facade.js"
import {
  type CodeExecutor,
  type CodeModeError,
  DEFAULT_EXECUTE_OPTS,
  type ExecuteOpts,
  type ExecuteResult,
  type ToolInvoker,
} from "./types.js"

/** JSON.parse reviver: drop `__proto__` keys (prototype-pollution guard, both directions). */
function nullProtoReviver(key: string, value: unknown): unknown {
  if (key === "__proto__") return undefined
  return value
}

function safeJsonParse(text: string): unknown {
  return JSON.parse(text, nullProtoReviver)
}

/**
 * Best-effort JSON.parse that returns `undefined` instead of throwing —
 * used by unwrapToolResult, where a parse failure is a normal, expected
 * outcome (plain-text tool output) rather than an error condition. Always
 * goes through the null-proto reviver (prototype-pollution guard) since the
 * text originates from an upstream source, not host-trusted code.
 */
function tryParseJson(text: string): unknown {
  try {
    return safeJsonParse(text)
  } catch {
    return undefined
  }
}

/**
 * A single MCP content part, as returned by any of the 5 provider kinds
 * (mcp/openapi/graphql/http/cli — see provider.ts's `ToolResult.content`,
 * documented as "follows MCP spec format"). Only the shape this file
 * actually inspects is modeled; other MCP content types (image/resource/
 * etc, reachable only via a raw MCP passthrough) pass through opaquely.
 */
interface McpTextContentPart {
  type: "text"
  text: string
}

function isTextContentPart(part: unknown): part is McpTextContentPart {
  return (
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  )
}

/**
 * An openapi/http-provider content string is `"<3-digit-status> <reason
 * phrase>\n<body>"` (see openapi-client/src/http.ts, http-client's provider
 * reuses the same engine) — e.g. "200 OK\n{\"greeting\":\"hi\"}". Detected
 * structurally (a leading 3-digit code + space, before the first newline)
 * rather than hardcoded to any one status/phrase, so any status line is
 * stripped correctly (404 Not Found, 500 Internal Server Error, ...). This
 * does NOT match cli-provider's "exit <n>[, output truncated...]" prefix
 * (starts with a word, not 3 digits), so cli output is never mistaken for an
 * HTTP status line and passed through untouched.
 */
const HTTP_STATUS_LINE = /^\d{3} [^\n]*\n/

/**
 * Strip a leading HTTP status line, if present. Returns the text unchanged
 * for every other provider kind's content (graphql's raw JSON body, mcp's
 * raw text, cli's "exit N\n<output>" — none of these match the pattern).
 */
function stripHttpStatusLine(text: string): string {
  const match = HTTP_STATUS_LINE.exec(text)
  return match ? text.slice(match[0].length) : text
}

/**
 * Unwrap one MCP text-content part's `text` into a usable guest value: try
 * an HTTP-status-line strip (openapi/http provider shape) then a JSON parse
 * (covers openapi/http bodies, graphql's raw JSON body, and any MCP source
 * whose single text part is JSON) — falling back to the raw string when the
 * text isn't JSON (cli's exit+stdout/stderr, plain-text MCP tool output,
 * etc). Every parse goes through the null-proto reviver.
 */
function unwrapTextPart(text: string): unknown {
  const stripped = stripHttpStatusLine(text)
  const parsed = tryParseJson(stripped)
  return parsed !== undefined ? parsed : stripped
}

/**
 * unwrapToolResult — turn an upstream ToolResult.content envelope into the
 * value the guest actually gets back from `await tools.<ns>.<tool>(...)`.
 * Per the method file's proof-of-done:
 *   1. A single {type:"text"} part whose text is JSON → the parsed value.
 *   2. A single {type:"text"} part whose text is NOT JSON → the raw string.
 *   3. Anything else (multi-part content, non-text parts, or content that
 *      isn't an MCP content array at all — e.g. a hand-built test fake) →
 *      returned as-is, never reshaped/lossy. A multi-part MCP array already
 *      IS a usable, documented array value once each part's own text (if
 *      any) has been unwrapped the same way as the single-part case, so
 *      guest code can do `parts[0]` / `parts.map(...)` without its own
 *      hand-parsing.
 *
 * PURE — no I/O, no QuickJS handles; operates on the already-marshaled,
 * already-byte-capped value (byte capping still happens at the caller after
 * this returns, via truncateToBytes on the re-stringified result).
 */
function unwrapToolResult(content: unknown): unknown {
  if (!Array.isArray(content)) return content

  if (content.length === 1 && isTextContentPart(content[0])) {
    return unwrapTextPart(content[0].text)
  }

  return content.map((part) => (isTextContentPart(part) ? unwrapTextPart(part.text) : part))
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

/** Truncate a UTF-8 string to a byte budget. */
function truncateToBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8")
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false }
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

export interface QuickJsExecutorOptions {
  sink: AuditSink
  principal: AuditPrincipal
  /** The routed profile this execution runs against. */
  profile: string
  /** LAZILY-resolved safeUpstreamMessage (mcp-server's secret-safe membrane) — see index.ts's runCode. */
  safeUpstreamMessage: (e: UpstreamError) => string
  /** Wire-name arity: true for prefixed (`<profile>__<ns>__<tool>`) multi-profile/global-key facades. */
  prefixed: boolean
}

/**
 * The in-process QuickJS-WASM CodeExecutor. One WASM module is loaded
 * lazily on first execute() and reused across calls (module load is the
 * expensive part); a FRESH runtime + context is created PER execute() call
 * so no guest state or facade binding leaks between executions.
 */
export class QuickJsExecutor implements CodeExecutor {
  private modulePromise: Promise<QuickJSAsyncWASMModule> | undefined

  constructor(private readonly options: QuickJsExecutorOptions) {}

  async execute(
    code: string,
    baseInvoker: ToolInvoker,
    optsOverride?: Partial<ExecuteOpts>,
  ): Promise<Result<ExecuteResult, CodeModeError>> {
    const opts: ExecuteOpts = { ...DEFAULT_EXECUTE_OPTS, ...optsOverride }

    let quickjsModule: QuickJSAsyncWASMModule
    try {
      this.modulePromise ??= newQuickJSAsyncWASMModuleFromVariant(variant)
      quickjsModule = await this.modulePromise
    } catch (cause) {
      return err({ kind: "module-load-failed", message: describeCause(cause) })
    }

    // Fresh correlationId ties this execution's inner tool_call lines to its
    // own wrapping code_exec line — never reused across executions.
    const correlationId = crypto.randomUUID()
    const startedAt = performance.now()

    const auditedInvoker: AuditedInvoker = createAuditedInvoker({
      proxy: baseInvoker,
      sink: this.options.sink,
      principal: this.options.principal,
      profile: this.options.profile,
      correlationId,
    })

    // Build the facade plan from the FILTERED tool list BEFORE touching
    // QuickJS at all — describe()/search()/the tools.* bridge are all
    // served from this ONE snapshot (never re-fetched upstream, per the
    // method file's "Do NOT" list).
    const tools = await auditedInvoker.listTools()
    const plan = buildFacadePlan(tools, this.options.prefixed)

    // ONE shared deadline for BOTH the QuickJS interrupt handler and
    // runGuestCode's own drain-loop deadline check — computing these
    // separately (each its own `Date.now() + opts.timeoutMs`) lets the
    // interrupt fire a few ms before runGuestCode's later-computed deadline,
    // which made a budget-exceeded interrupt misclassify as "guest-error"
    // instead of "timeout" (empirically observed: an ~11ms gap between the
    // two calls was enough to trigger this every time).
    const deadline = Date.now() + opts.timeoutMs

    const runtime = quickjsModule.newRuntime()
    runtime.setMemoryLimit(opts.memoryBytes)
    runtime.setMaxStackSize(opts.maxStackBytes)
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline))

    const context = runtime.newContext()

    const logs: string[] = []
    let logBytesUsed = 0
    let emitted = 0

    const captureLog = (text: string): void => {
      if (logBytesUsed >= opts.logByteCap) return
      const { text: bounded, truncated } = truncateToBytes(text, opts.logByteCap - logBytesUsed)
      logs.push(truncated ? `${bounded}…[truncated]` : bounded)
      logBytesUsed += byteLength(bounded)
    }

    let outcomeErrorKind: "timeout" | "guest-error" | "memory" | "internal" | null = null

    // EVERY facade tool call's in-flight deferred is tracked here so the
    // finally block can settle+dispose any that are STILL PENDING before
    // context.dispose() runs. This closes a guest-reachable process-level
    // DoS (HIGH, inc 33b sandbox-security review): a tool call whose host
    // promise outlives the remaining budget leaves an unsettled
    // QuickJSDeferredPromise (+ its guest Promise) in QuickJS's GC object
    // list; disposing the context then hits `list_empty(&rt->gc_obj_list)`
    // in JS_FreeRuntime → a WASM abort() (NOT a catchable throw — the
    // try/catch below cannot contain it), crashing the whole process. On the
    // shared long-lived MCP server that is a DoS for every consumer. The
    // `.alive` guards in the bridge callbacks only stop a LATE callback from
    // throwing; they do not free a promise that never settled — this drain
    // does.
    const pendingDeferreds = new Set<QuickJSDeferredPromise>()

    try {
      // ONE Scope spans facade installation THROUGH guest execution — every
      // console/emit/tool-bridge handle installed below must stay ALIVE
      // while the guest runs (facade functions are CALLED DURING the drain
      // loop below, not during installation). Disposing the scope right
      // after installation frees those handles before the guest ever calls
      // them — empirically confirmed to corrupt the runtime.
      //
      // OUTER WALL-CLOCK BACKSTOP: the QuickJS interrupt handler only bounds
      // guest CPU — it CANNOT interrupt a wedged/slow HOST-side tool promise
      // the guest is awaiting (that promise runs on the Node event loop,
      // outside the WASM interpreter). So race the whole execution against a
      // real host timer set a small margin past the deadline; a stuck host
      // call resolves to a clean timeout instead of hanging forever. The
      // pending-deferred drain in `finally` then frees the still-in-flight
      // promise safely.
      const execution: Promise<RunOutcome> = Scope.withScopeAsync(async (scope) => {
        installConsole(context, scope, captureLog)
        installEmit(context, scope, captureLog, () => {
          emitted += 1
        })
        installTools(
          context,
          scope,
          auditedInvoker,
          plan,
          opts,
          this.options.safeUpstreamMessage,
          pendingDeferreds,
        )

        return runGuestCode(context, runtime, code, deadline)
      })
      // If the OUTER timer wins the race, `execution` is left un-awaited and
      // could later reject (e.g. a Scope-disposal throw against the context
      // this finally will already have disposed) → an unhandled promise
      // rejection that could crash the process under strict mode. Attach a
      // no-op catch so a late rejection is swallowed. The result is still
      // taken from the race below, not from this handle.
      execution.catch(() => {})
      const runOutcome = await Promise.race([execution, outerTimeout(opts.timeoutMs)])

      if (runOutcome.kind === "timeout") {
        outcomeErrorKind = "timeout"
        return ok({ ok: false, kind: "timeout", message: `execution exceeded ${opts.timeoutMs}ms` })
      }
      if (runOutcome.kind === "memory") {
        outcomeErrorKind = "memory"
        return ok({ ok: false, kind: "memory", message: runOutcome.message })
      }
      if (runOutcome.kind === "guest-error") {
        outcomeErrorKind = "guest-error"
        return ok({ ok: false, kind: "guest-error", message: runOutcome.message })
      }

      const rawResultJson = JSON.stringify(runOutcome.value) ?? "null"
      const { text: resultText, truncated: resultTruncated } = truncateToBytes(
        rawResultJson,
        opts.resultByteCap,
      )
      const value = resultTruncated ? null : safeJsonParse(resultText)

      return ok({ ok: true, value, logs, emitted, toolCallCount: auditedInvoker.toolCallCount })
    } catch (cause) {
      outcomeErrorKind = "internal"
      return err({ kind: "dispose-failed", message: describeCause(cause) })
    } finally {
      const durationMs = performance.now() - startedAt
      emitCodeExec({
        sink: this.options.sink,
        correlationId,
        principal: this.options.principal,
        profile: this.options.profile,
        durationMs,
        outcome: outcomeErrorKind === null ? "ok" : "error",
        errorKind: outcomeErrorKind,
        toolCallCount: auditedInvoker.toolCallCount,
      })
      // Settle+dispose any still-in-flight tool-call deferreds BEFORE
      // disposing the context — otherwise an unsettled promise in the GC
      // list aborts the process at JS_FreeRuntime (see pendingDeferreds).
      drainPendingDeferreds(context, runtime, pendingDeferreds)
      // Dispose context BEFORE runtime — a leaked handle throws here, the
      // deliberate leak signature the handle-leak regression test relies on.
      context.dispose()
      runtime.dispose()
    }
  }
}

type RunOutcome =
  | { kind: "ok"; value: unknown }
  | { kind: "guest-error"; message: string }
  | { kind: "memory"; message: string }
  | { kind: "timeout" }

/**
 * QuickJS reports both a heap-limit hit (setMemoryLimit) and a stack-limit
 * hit (setMaxStackSize) as an ordinary guest exception with one of these
 * message texts — there is no structured error kind to switch on. Matching
 * by substring is the only signal available; false positives are
 * essentially impossible (a guest throwing an error literally named "out of
 * memory" would be classified as a budget hit too, which is an acceptable,
 * conservative default).
 */
function isMemoryOrStackError(message: string): boolean {
  return (
    message.includes("out of memory") ||
    message.includes("stack overflow") ||
    message.includes("Stack overflow")
  )
}

/** Hard ceiling on drain-loop iterations — a circuit breaker independent of the wall-clock deadline check. */
const MAX_DRAIN_ITERATIONS = 1_000_000
/** How long the drain loop yields to the host event loop between polls — bounds latency without busy-spinning. */
const DRAIN_POLL_INTERVAL_MS = 1
/**
 * Grace period added to the outer wall-clock backstop past the guest-CPU
 * deadline. The interrupt-driven drain loop should always finish first for a
 * well-behaved guest; this outer Promise.race only fires when a HOST-side
 * tool promise the guest is awaiting is wedged/slow (which the interrupt
 * handler cannot touch). The margin keeps the two mechanisms from racing on
 * a normal timeout — the interrupt path wins and returns first.
 */
const OUTER_TIMEOUT_MARGIN_MS = 2_000

/**
 * The outer wall-clock backstop (see execute()): resolves to a timeout
 * RunOutcome `OUTER_TIMEOUT_MARGIN_MS` after the guest-CPU deadline. Raced
 * against the execution so a wedged HOST-side tool call (outside the WASM
 * interpreter, unreachable by the CPU interrupt) is bounded independently.
 */
function outerTimeout(timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ kind: "timeout" }), timeoutMs + OUTER_TIMEOUT_MARGIN_MS)
  })
}

/**
 * Settle and dispose every still-pending tool-call deferred, then flush the
 * job queue once so QuickJS actually frees the associated promise objects
 * out of its GC list — MUST run before context.dispose() to avoid the
 * `list_empty(&rt->gc_obj_list)` abort (see execute()'s pendingDeferreds
 * comment). Rejecting with an opaque, non-secret-bearing error is safe: by
 * the time this runs the guest is no longer observing the promise (the
 * execution already resolved to a timeout/error outcome), and even if a
 * late microtask did observe it, the message carries no host detail.
 * Best-effort and self-contained: never throws into the caller (a dispose
 * failure must not mask the real outcome).
 */
function drainPendingDeferreds(
  context: QuickJSAsyncContext,
  runtime: QuickJSAsyncRuntime,
  pending: Set<QuickJSDeferredPromise>,
): void {
  if (pending.size === 0) return
  try {
    for (const deferred of pending) {
      if (deferred.alive) {
        using errHandle = context.newError("execution ended before the tool call completed")
        deferred.reject(errHandle)
      }
      deferred.dispose()
    }
    // One flush empties the now-settled promises out of the GC object list.
    runtime.executePendingJobs()
  } catch {
    // Best-effort: a failure here must not mask the execution's real outcome.
  } finally {
    pending.clear()
  }
}

/**
 * Eval the guest code (wrapped in an async IIFE so the guest gets `await`)
 * and drive it to completion via a host-side poll loop.
 *
 * WRAPPED IN AN ASYNC IIFE (`(async () => { ...code })()`): this QuickJS
 * build's `evalCode` does NOT support top-level `await` in "global" eval
 * mode (a SyntaxError — empirically confirmed), and `type: "module"` mode
 * brings `import`/`export` into scope, which the facade must never expose
 * (zero ambient authority). The IIFE gives the guest `await` without either
 * problem — global eval mode stays in effect, so `import`/`export` remain
 * syntax errors.
 *
 * The facade's tool bridge uses SYNC `newFunction` + `newPromise()`
 * deferreds (see installTools), never `newAsyncifiedFunction` — so this
 * eval is a plain `context.evalCode` (sync), not `evalCodeAsync`. Calling
 * the async IIFE synchronously returns a Promise handle immediately (JS
 * semantics: an async function call always returns a Promise without
 * blocking); the deferred-backed tool calls inside it settle via the host's
 * real setTimeout/Promise machinery, picked up by the poll loop below.
 */
/**
 * Classify a QuickJS guest error handle into a RunOutcome — shared by the two
 * error paths in runGuestCode (an eval-time error handle and a
 * rejected-promise error handle), which are otherwise byte-identical.
 *
 * Takes OWNERSHIP of `errorHandle` and disposes it before returning (the
 * `using` scoping the callers previously relied on moves in here).
 *
 * ORDER IS LOAD-BEARING: the deadline check runs BEFORE dumping the handle, so
 * a guest error that fires only because the interrupt/deadline tripped is
 * reclassified as "timeout" (a consistent budget-exceeded signal) rather than
 * "guest-error" — regardless of where the interrupt happened to fire.
 */
function classifyGuestError(
  context: QuickJSAsyncContext,
  errorHandle: QuickJSHandle,
  deadline: number,
): RunOutcome {
  using handle = errorHandle
  if (Date.now() >= deadline) {
    return { kind: "timeout" }
  }
  const message = describeGuestError(context.dump(handle))
  if (isMemoryOrStackError(message)) {
    return { kind: "memory", message }
  }
  return { kind: "guest-error", message }
}

async function runGuestCode(
  context: QuickJSAsyncContext,
  runtime: QuickJSAsyncRuntime,
  code: string,
  deadline: number,
): Promise<RunOutcome> {
  const wrapped = `(async () => {\n${code}\n})()`
  const evalResult = context.evalCode(wrapped)
  if (evalResult.error) {
    // shouldInterruptAfterDeadline fires QuickJS's OWN interrupt check
    // (a tight guest loop like `while(true){}` never reaches the drain
    // loop's deadline check below — evalCode itself returns an error the
    // instant the interrupt handler trips). classifyGuestError's deadline-
    // first ordering reclassifies that as "timeout" (not "guest-error"), so
    // callers see a consistent budget-exceeded signal regardless of WHERE the
    // interrupt happened to fire.
    return classifyGuestError(context, evalResult.error, deadline)
  }
  using promiseHandle = evalResult.value

  for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
    const state = context.getPromiseState(promiseHandle)
    if (state.type === "fulfilled") {
      using valueHandle = state.value
      return { kind: "ok", value: context.dump(valueHandle) }
    }
    if (state.type === "rejected") {
      return classifyGuestError(context, state.error, deadline)
    }
    if (Date.now() >= deadline) {
      return { kind: "timeout" }
    }

    // Yield to the host event loop so pending setTimeout/host-Promise
    // callbacks (the deferred-promise resolutions from installTools' bridge
    // functions) actually fire BEFORE the next executePendingJobs call —
    // empirically required: a tight synchronous poll loop can race ahead of
    // the host callbacks that settle the guest's deferred promises.
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS))

    const drainResult = runtime.executePendingJobs()
    if (drainResult.error) {
      using errorHandle = drainResult.error
      return { kind: "guest-error", message: describeGuestError(context.dump(errorHandle)) }
    }
  }
  return { kind: "timeout" }
}

function describeGuestError(dumped: unknown): string {
  if (dumped && typeof dumped === "object" && "message" in dumped) {
    const message = (dumped as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  if (typeof dumped === "string") return dumped
  try {
    return JSON.stringify(dumped) ?? "unknown guest error"
  } catch {
    return "unknown guest error"
  }
}

// ---------------------------------------------------------------------------
// Facade installation — tools / console / emit ONLY (zero ambient authority)
// ---------------------------------------------------------------------------

function installConsole(
  context: QuickJSAsyncContext,
  scope: Scope,
  onLog: (text: string) => void,
): void {
  const consoleHandle = scope.manage(context.newObject())
  const logFn = scope.manage(
    context.newFunction("log", (...args: QuickJSHandle[]) => {
      onLog(args.map((a) => stringifyHandle(context, a)).join(" "))
    }),
  )
  const errorFn = scope.manage(
    context.newFunction("error", (...args: QuickJSHandle[]) => {
      onLog(`[error] ${args.map((a) => stringifyHandle(context, a)).join(" ")}`)
    }),
  )
  context.setProp(consoleHandle, "log", logFn)
  context.setProp(consoleHandle, "error", errorFn)
  context.setProp(context.global, "console", consoleHandle)
}

function installEmit(
  context: QuickJSAsyncContext,
  scope: Scope,
  onLog: (text: string) => void,
  onEmit: (value: unknown) => void,
): void {
  const emitFn = scope.manage(
    context.newFunction("emit", (valueHandle?: QuickJSHandle) => {
      const dumped = valueHandle ? context.dump(valueHandle) : undefined
      onEmit(dumped)
      onLog(typeof dumped === "string" ? dumped : (JSON.stringify(dumped) ?? ""))
    }),
  )
  context.setProp(context.global, "emit", emitFn)
}

function stringifyHandle(context: QuickJSAsyncContext, handle: QuickJSHandle): string {
  const dumped = context.dump(handle)
  if (typeof dumped === "string") return dumped
  try {
    return JSON.stringify(dumped) ?? String(dumped)
  } catch {
    return String(dumped)
  }
}

/** Guard message every enumeration trap throws — matches the method file's exact guidance text. */
const ENUMERATION_GUARD_MESSAGE = "use tools.search() to discover tools"

/**
 * Bootstrap eval that wraps a raw `__rawTools` global (built host-side below)
 * in a Proxy whose `ownKeys`/`getOwnPropertyDescriptor` traps THROW — this is
 * the ONLY thing that makes `Object.keys(tools)`/`for...in tools`/spread
 * actually throw (empirically verified: QuickJS's own setProp/defineProp
 * enumerable:false is skipped SILENTLY by Object.keys/for-in, it does not
 * throw — only a JS-level Proxy ownKeys trap can enforce "throws", which is
 * the method file's literal requirement). Applied recursively to `tools`
 * itself AND every per-namespace sub-object, so `Object.keys(tools.github)`
 * throws too. `has` stays a passthrough so `"foo" in tools.github` still
 * works for legitimate guest existence checks.
 */
const TOOLS_PROXY_BOOTSTRAP = `
(function () {
  function guard(target) {
    return new Proxy(target, {
      ownKeys() { throw new Error(${JSON.stringify(ENUMERATION_GUARD_MESSAGE)}); },
      getOwnPropertyDescriptor() { throw new Error(${JSON.stringify(ENUMERATION_GUARD_MESSAGE)}); },
      has(target, key) { return key in target; },
    });
  }
  // Each tool bridge function (installed host-side as a sync newFunction,
  // see installTools) resolves its Promise with a JSON-TEXT STRING — the
  // host cannot construct an arbitrary QuickJS value handle (object/array)
  // directly from installTools' JS side, only primitives/strings via the
  // newFunction return. Wrapping here (guest-side) is what actually turns
  // that JSON text into the parsed value/array/object the guest's
  // \`await tools.<ns>.<tool>(...)\` expression observes — this is the fix
  // for the ergonomics bug (33f): before this wrap, guest code had to
  // hand-parse the resolved string itself. A guest-side JSON.parse here
  // only touches the GUEST's own isolated QuickJS heap/Object.prototype
  // (a completely separate realm from the host's — see the
  // prototype-pollution guard tests) — it is NOT the host-trust-boundary
  // JSON.parse the null-proto reviver guards (that already ran host-side,
  // in unwrapToolResult/safeJsonParse, before this text was ever built).
  function wrapToolFn(fn) {
    return function (...args) {
      return fn.apply(null, args).then(function (text) {
        try {
          return JSON.parse(text);
        } catch (e) {
          return text;
        }
      });
    };
  }
  const raw = globalThis.__rawTools;
  for (const ns of Object.keys(raw)) {
    if (ns === "search" || ns === "describe") continue;
    const nsObj = raw[ns];
    for (const toolName of Object.keys(nsObj)) {
      nsObj[toolName] = wrapToolFn(nsObj[toolName]);
    }
    raw[ns] = guard(nsObj);
  }
  globalThis.tools = guard(raw);
  delete globalThis.__rawTools;
})();
`

/**
 * Install the `tools` facade. Every per-tool bridge function is a SYNC
 * `newFunction` (never `newAsyncifiedFunction` — see this file's header for
 * why) that creates a `context.newPromise()` deferred, kicks off the real
 * host `invoker.callTool` call, and resolves/rejects the deferred from
 * inside a `.then`/`.catch` continuation. The returned `deferred.handle` is
 * consumed by the QuickJS caller (per the library's documented contract:
 * "as the return value of a VmFunctionImplementation, return handle, and
 * ensure resolve or reject will be called — no other cleanup necessary").
 * The error/success VALUE handles passed to resolve/reject are each
 * `using`-scoped — resolve/reject dup what they need internally, so the
 * caller must still dispose its own reference (verified empirically: not
 * disposing the handle passed to `reject` leaks it and corrupts dispose).
 *
 * ASYNC-PATH deferreds are registered in `pendingDeferreds` on dispatch and
 * removed when they settle, so execute()'s finally block can force-settle
 * any still-in-flight ones before context.dispose() (the DoS fix — see
 * execute()'s pendingDeferreds comment). Sync-reject paths (arg-cap /
 * JSON-parse) settle before returning, so they are never in-flight at
 * dispose and need not be tracked.
 *
 * RESULT SHAPE (33f): a successful call resolves with unwrapToolResult's
 * output (parsed JSON body / plain string / structured array — see its doc
 * comment), JSON-text-stringified across the FFI and JSON.parsed back by the
 * guest-side wrapToolFn (TOOLS_PROXY_BOOTSTRAP) — so `await
 * tools.<ns>.<tool>(args)` returns the usable value directly, not the raw
 * MCP content envelope. `isError:true` results reject the SAME way an
 * upstream Err does (a thrown guest Error), with the unwrapped content as
 * the message — never a raw host cause/secret (that's still exclusively
 * safeUpstreamMessage's job, on the isErr() branch above).
 */
function installTools(
  context: QuickJSAsyncContext,
  scope: Scope,
  invoker: AuditedInvoker,
  plan: FacadePlan,
  opts: ExecuteOpts,
  safeUpstreamMessage: (e: UpstreamError) => string,
  pendingDeferreds: Set<QuickJSDeferredPromise>,
): void {
  const rawToolsHandle = scope.manage(context.newObject())

  for (const [namespace, toolMap] of plan.byNamespace) {
    const nsHandle = scope.manage(context.newObject())
    for (const [toolName, entry] of toolMap) {
      const fn = scope.manage(
        context.newFunction(toolName, (argsHandle?: QuickJSHandle) => {
          const deferred = context.newPromise()

          const argsJson = argsHandle ? stringifyHandle(context, argsHandle) : "{}"
          if (byteLength(argsJson) > opts.argByteCap) {
            using errHandle = context.newError(`arguments exceed ${opts.argByteCap} bytes`)
            deferred.reject(errHandle)
            return deferred.handle
          }

          let args: Record<string, unknown>
          try {
            const parsed = safeJsonParse(argsJson)
            args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
          } catch {
            // NOTE: explicit create/reject/dispose rather than `using` here.
            // Every other error-handle in this file uses `using`, but oxc (the
            // tsdown/rolldown transform) does NOT downlevel a `using`
            // declaration sitting directly inside a `catch {}` block — it ships
            // the raw `using` keyword, which is a SyntaxError under the repo's
            // Node 20/22 floor (native ERM lands only in Node 24). The manual
            // dispose is equivalent (reject reads the handle synchronously) and
            // sidesteps that oxc gap. See docs/futures/gotchas.md.
            const errHandle = context.newError("invalid arguments: not valid JSON")
            deferred.reject(errHandle)
            errHandle.dispose()
            return deferred.handle
          }

          // ASYNC path: track until settled so the finally-block drain can
          // force-settle it if the host call outlives the budget.
          pendingDeferreds.add(deferred)

          invoker
            .callTool(entry.wireName, args)
            .then((result) => {
              pendingDeferreds.delete(deferred)
              // deferred.alive: resolve/reject after dispose is documented
              // as a no-op, but disposing/creating handles on an already-
              // disposed context still throws — guard explicitly rather
              // than rely on the no-op alone (a timeout can dispose the
              // context while a host call is still in flight; the
              // finally-block drain may also have already settled+disposed
              // this deferred).
              if (!deferred.alive) return
              if (result.isErr()) {
                // SECRET-SAFE: the guest sees ONLY the opaque
                // safeUpstreamMessage string, never e.cause/body/secret —
                // the invoker's audit line already captured the
                // discriminated errorKind tag separately.
                using errHandle = context.newError(safeUpstreamMessage(result.error))
                deferred.reject(errHandle)
                return
              }
              // unwrapToolResult turns the raw MCP content envelope into a
              // usable value (parsed JSON body / plain string / structured
              // multi-part array — see unwrapToolResult's doc comment for
              // the per-provider-kind shapes).
              const unwrapped = unwrapToolResult(result.value.content)
              if (result.value.isError === true) {
                // isError:true — the TRANSPORT succeeded but the tool's own
                // response signals an application-level failure (e.g. an
                // openapi 4xx/5xx body, a GraphQL errors-only response, a
                // non-zero CLI exit). This is content the tool itself
                // returned for the caller to see (same content that would
                // have resolved had isError been false) — NOT a host-side
                // cause/secret, so surfacing it verbatim (bounded, unwrapped,
                // human-readable — not re-JSON-stringified into a quoted
                // blob) carries no more risk than the resolve path already
                // does. Surfaced via the SAME guest error channel as an
                // upstream Err (a thrown Error) for a single, consistent
                // contract: "a tool call failure is always a thrown/rejected
                // guest error", never a silently-ok value the guest could
                // forget to check.
                const displayText =
                  typeof unwrapped === "string" ? unwrapped : (JSON.stringify(unwrapped) ?? "null")
                const { text: boundedError } = truncateToBytes(displayText, opts.resultByteCap)
                using errHandle = context.newError(boundedError)
                deferred.reject(errHandle)
                return
              }
              // Re-stringified so the SAME byte-cap + FFI-string-crossing
              // mechanics apply as before — only WHAT gets capped changed
              // (the unwrapped value instead of the raw content array),
              // never the cap itself. The guest side's wrapToolFn
              // (TOOLS_PROXY_BOOTSTRAP) JSON.parses this text back into the
              // value the guest's `await` observes.
              const resultJson = JSON.stringify(unwrapped) ?? "null"
              const { text: bounded } = truncateToBytes(resultJson, opts.resultByteCap)
              using strHandle = context.newString(bounded)
              deferred.resolve(strHandle)
            })
            .catch(() => {
              pendingDeferreds.delete(deferred)
              if (!deferred.alive) return
              // GUEST-FACING ERROR CHANNEL — MUST STAY NON-SECRET-BEARING.
              // This catch fires on an UNEXPECTED host-side throw (not a
              // typed UpstreamError — those go through the isErr() branch
              // above via safeUpstreamMessage). The thrown `cause` could be
              // anything (an axios-like object with Authorization headers, a
              // stack with paths), so it is DELIBERATELY discarded here and a
              // fixed opaque string crosses into the guest. The host-facing
              // describeCause is reserved for the executor's OWN Result
              // (module-load/dispose failures), which never reaches the guest.
              using errHandle = context.newError("tool call failed")
              deferred.reject(errHandle)
            })

          return deferred.handle
        }),
      )
      context.setProp(nsHandle, toolName, fn)
    }
    context.setProp(rawToolsHandle, namespace, nsHandle)
  }

  const searchFn = scope.manage(
    context.newFunction("search", (queryHandle?: QuickJSHandle) => {
      const arg = queryHandle ? context.dump(queryHandle) : undefined
      const query =
        typeof arg === "string" ? arg : ((arg as { query?: string } | undefined)?.query ?? "")
      return context.newString(JSON.stringify(searchFacade(plan, query)) ?? "[]")
    }),
  )
  context.setProp(rawToolsHandle, "search", searchFn)

  const describeHandle = scope.manage(context.newObject())
  const describeToolFn = scope.manage(
    context.newFunction("tool", (pathHandle?: QuickJSHandle) => {
      const arg = pathHandle ? context.dump(pathHandle) : undefined
      const path = typeof arg === "string" ? arg : (arg as { path?: string } | undefined)?.path
      const found = path ? describeFacadeTool(plan, path) : undefined
      return context.newString(JSON.stringify(found ?? null) ?? "null")
    }),
  )
  context.setProp(describeHandle, "tool", describeToolFn)
  context.setProp(rawToolsHandle, "describe", describeHandle)

  context.setProp(context.global, "__rawTools", rawToolsHandle)

  const bootstrapResult = context.evalCode(TOOLS_PROXY_BOOTSTRAP)
  if (bootstrapResult.error) {
    using errorHandle = bootstrapResult.error
    const dumped = context.dump(errorHandle)
    throw new Error(`facade bootstrap failed: ${JSON.stringify(dumped)}`)
  }
  bootstrapResult.value.dispose()
}
