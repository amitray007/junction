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

    try {
      // ONE Scope spans facade installation THROUGH guest execution — every
      // console/emit/tool-bridge handle installed below must stay ALIVE
      // while the guest runs (facade functions are CALLED DURING the drain
      // loop below, not during installation). Disposing the scope right
      // after installation frees those handles before the guest ever calls
      // them — empirically confirmed to corrupt the runtime.
      const runOutcome = await Scope.withScopeAsync(async (scope) => {
        installConsole(context, scope, captureLog)
        installEmit(context, scope, captureLog, () => {
          emitted += 1
        })
        installTools(context, scope, auditedInvoker, plan, opts, this.options.safeUpstreamMessage)

        return runGuestCode(context, runtime, code, deadline)
      })

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
async function runGuestCode(
  context: QuickJSAsyncContext,
  runtime: QuickJSAsyncRuntime,
  code: string,
  deadline: number,
): Promise<RunOutcome> {
  const wrapped = `(async () => {\n${code}\n})()`
  const evalResult = context.evalCode(wrapped)
  if (evalResult.error) {
    using errorHandle = evalResult.error
    // shouldInterruptAfterDeadline fires QuickJS's OWN interrupt check
    // (a tight guest loop like `while(true){}` never reaches the drain
    // loop's deadline check below — evalCode itself returns an error the
    // instant the interrupt handler trips). Reclassify as "timeout" (not
    // "guest-error") whenever the deadline has already passed, so callers
    // see a consistent budget-exceeded signal regardless of WHERE the
    // interrupt happened to fire.
    if (Date.now() >= deadline) {
      return { kind: "timeout" }
    }
    const message = describeGuestError(context.dump(errorHandle))
    if (isMemoryOrStackError(message)) {
      return { kind: "memory", message }
    }
    return { kind: "guest-error", message }
  }
  using promiseHandle = evalResult.value

  for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
    const state = context.getPromiseState(promiseHandle)
    if (state.type === "fulfilled") {
      using valueHandle = state.value
      return { kind: "ok", value: context.dump(valueHandle) }
    }
    if (state.type === "rejected") {
      using errorHandle = state.error
      if (Date.now() >= deadline) {
        return { kind: "timeout" }
      }
      const message = describeGuestError(context.dump(errorHandle))
      if (isMemoryOrStackError(message)) {
        return { kind: "memory", message }
      }
      return { kind: "guest-error", message }
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
  const raw = globalThis.__rawTools;
  for (const ns of Object.keys(raw)) {
    if (ns === "search" || ns === "describe") continue;
    raw[ns] = guard(raw[ns]);
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
 */
function installTools(
  context: QuickJSAsyncContext,
  scope: Scope,
  invoker: AuditedInvoker,
  plan: FacadePlan,
  opts: ExecuteOpts,
  safeUpstreamMessage: (e: UpstreamError) => string,
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
            using errHandle = context.newError("invalid arguments: not valid JSON")
            deferred.reject(errHandle)
            return deferred.handle
          }

          invoker
            .callTool(entry.wireName, args)
            .then((result) => {
              // deferred.alive: resolve/reject after dispose is documented
              // as a no-op, but disposing/creating handles on an already-
              // disposed context still throws — guard explicitly rather
              // than rely on the no-op alone (a timeout can dispose the
              // context while a host call is still in flight).
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
              const resultJson = JSON.stringify(result.value.content) ?? "null"
              const { text: bounded } = truncateToBytes(resultJson, opts.resultByteCap)
              using strHandle = context.newString(bounded)
              deferred.resolve(strHandle)
            })
            .catch((cause: unknown) => {
              if (!deferred.alive) return
              using errHandle = context.newError(describeCause(cause))
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
