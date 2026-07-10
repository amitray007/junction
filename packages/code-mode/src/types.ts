// SPDX-License-Identifier: AGPL-3.0-only
// Public types for @junction/code-mode — the CodeExecutor contract, the thin
// ToolInvoker the executor calls (a ProfileProxy adapts to it), and the
// execute() result/options shapes.
//
// SOURCE-AGNOSTIC / RUNTIME-AGNOSTIC: this file has ZERO QuickJS imports —
// it's the interface a QuickJsExecutor (or a future Deno-subprocess
// executor, see docs/futures/revisit-when.md) implements. Keeping the
// contract free of quickjs-emscripten types means a caller (cli, mcp/server)
// can depend on CodeExecutor without pulling in the WASM runtime type
// surface transitively through its public API.

import type { ProviderTool, ToolResult, UpstreamError } from "@junction/core"
import type { Result } from "neverthrow"

// ---------------------------------------------------------------------------
// ToolInvoker — the thin host-call surface the executor drives
// ---------------------------------------------------------------------------

/**
 * The RAW (un-audited) surface `CodeExecutor.execute()` accepts — what the
 * caller (cli/mcp-server composition root) hands in. A `ProfileProxy`
 * (core/src/sources/proxy.ts) satisfies this shape structurally (both
 * methods return a `Result`-shaped value); it's expressed here as a plain
 * `Promise<Result>` (not `ResultAsync`) purely so this package doesn't need
 * a direct type import of `ResultAsync`'s thenable machinery, and so a
 * caller can pass a hand-built proxy (e.g. QA test fakes) without pulling
 * in neverthrow's ResultAsync class.
 *
 * The executor wraps this in `createAuditedInvoker` (audited-invoker.ts)
 * BEFORE the guest ever sees it — every `callTool` crossing that wrapper is
 * individually audited (the security contract — see the method file's hard
 * invariants). Guest-facing code never talks to a `ToolInvoker` directly;
 * see `AuditedInvoker` for the post-audit facade-consumption shape.
 */
export interface ToolInvoker {
  listTools(): Promise<Result<ProviderTool[], UpstreamError>>
  callTool(name: string, args: Record<string, unknown>): Promise<Result<ToolResult, UpstreamError>>
}

// ---------------------------------------------------------------------------
// ExecuteOpts — budgets (memory, stack, deadline, byte caps)
// ---------------------------------------------------------------------------

/** Budgets enforced around one `execute()` call. Every field has a sane default (see DEFAULT_EXECUTE_OPTS). */
export interface ExecuteOpts {
  /** Outer wall-clock budget for the whole execution (Promise.race). */
  timeoutMs: number
  /** QuickJS guest heap ceiling (runtime.setMemoryLimit). */
  memoryBytes: number
  /** QuickJS guest stack ceiling (runtime.setMaxStackSize). */
  maxStackBytes: number
  /** Max serialized byte length of a single facade call's JSON-encoded args. */
  argByteCap: number
  /** Max serialized byte length of a single facade call's JSON-encoded result. */
  resultByteCap: number
  /** Max total bytes captured across all console.log/error + emit() calls (truncated, flagged). */
  logByteCap: number
}

/** Sane v1 defaults — see docs/methods/33b-code-mode-package.md proof-of-done #4. */
export const DEFAULT_EXECUTE_OPTS: ExecuteOpts = {
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024, // 64 MiB
  maxStackBytes: 1024 * 1024, // 1 MiB
  argByteCap: 256 * 1024, // 256 KiB
  resultByteCap: 1024 * 1024, // 1 MiB
  logByteCap: 64 * 1024, // 64 KiB
}

// ---------------------------------------------------------------------------
// ExecuteResult — success or a typed, host-stack-free failure
// ---------------------------------------------------------------------------

/** Successful execution: the returned value, captured logs, and counters. */
export interface ExecuteResultOk {
  ok: true
  value: unknown
  /** Bounded console.log/error + emit() output, in call order. */
  logs: string[]
  /** Count of emit() calls (the value payloads themselves are folded into `logs`). */
  emitted: number
  /** Count of facade tool calls made during this execution (mirrors the code_exec audit's toolCallCount). */
  toolCallCount: number
}

/**
 * Failed execution — ALWAYS host-stack-free (no Error.stack, no upstream
 * cause, no secret). `kind` distinguishes:
 *   - "guest-error": the guest code itself threw/rejected (a bug in the
 *     agent's JS, or a facade call whose host/tool Err was surfaced via
 *     safeUpstreamMessage — see audited-invoker.ts).
 *   - "timeout": the outer ExecuteOpts.timeoutMs budget was exceeded.
 *   - "memory": the QuickJS memory/stack limit was hit.
 *   - "internal": an executor-side failure unrelated to the guest's code
 *     (module load failure, disposal failure, etc.) — logged host-side only.
 */
export interface ExecuteResultErr {
  ok: false
  kind: "guest-error" | "timeout" | "memory" | "internal"
  message: string
}

export type ExecuteResult = ExecuteResultOk | ExecuteResultErr

// ---------------------------------------------------------------------------
// CodeModeError — CodeExecutor.execute()'s Result error channel
// ---------------------------------------------------------------------------

/**
 * Errors from the EXECUTOR itself (setup/teardown), distinct from
 * `ExecuteResultErr` (a GUEST-side outcome that is still `Ok` from the
 * executor's point of view — the execution completed and produced a typed
 * failure). `CodeModeError` is for cases execute() cannot even attempt to
 * run/complete the guest code.
 */
export type CodeModeError =
  | { kind: "module-load-failed"; message: string }
  | { kind: "dispose-failed"; message: string }

// ---------------------------------------------------------------------------
// CodeExecutor — the runtime-agnostic contract
// ---------------------------------------------------------------------------

/**
 * Runtime-agnostic contract for executing agent-authored JS against a
 * profile's brokered tools. v1 ships `QuickJsExecutor` (in-process
 * QuickJS-WASM asyncify); a future Deno-subprocess executor (the recorded
 * escalation path — see docs/futures/revisit-when.md) implements the same
 * interface, so callers (cli, mcp/server) never depend on the runtime
 * concretely.
 */
export interface CodeExecutor {
  execute(
    code: string,
    invoker: ToolInvoker,
    opts?: Partial<ExecuteOpts>,
  ): Promise<Result<ExecuteResult, CodeModeError>>
}
