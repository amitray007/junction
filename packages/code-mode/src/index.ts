// SPDX-License-Identifier: AGPL-3.0-only
// @junction/code-mode public API — narrow barrel.
//
// QuickJS deps (quickjs-emscripten-core, @jitl/quickjs-singlefile-mjs-release-asyncify)
// are confined to THIS package (junction-package-boundary gate; core stays
// pure/embeddable — see CLAUDE.md's Architecture section and
// docs/methods/33b-code-mode-package.md's hard invariants).

import type { AuditPrincipal, AuditSink, UpstreamError } from "@junction/core"
import type { Result } from "neverthrow"
import { QuickJsExecutor } from "./quickjs-executor.js"
import type {
  CodeExecutor,
  CodeModeError,
  ExecuteOpts,
  ExecuteResult,
  ToolInvoker,
} from "./types.js"

export type { ProxyLike } from "./audited-invoker.js"
export { createAuditedInvoker } from "./audited-invoker.js"
export type { DescribeResult, FacadePlan, FacadeToolEntry, SearchResult } from "./facade.js"
export {
  buildFacadePlan,
  describeFacadeTool,
  RESULT_SHAPE_GUIDANCE,
  searchFacade,
} from "./facade.js"
export { QuickJsExecutor, type QuickJsExecutorOptions } from "./quickjs-executor.js"
export {
  type CodeExecutor,
  type CodeModeError,
  DEFAULT_EXECUTE_OPTS,
  type ExecuteOpts,
  type ExecuteResult,
  type ExecuteResultErr,
  type ExecuteResultOk,
  type ToolInvoker,
} from "./types.js"

/** Options for the `runCode` convenience wrapper. */
export interface RunCodeOptions {
  principal: AuditPrincipal
  sink: AuditSink
  profile: string
  /** LAZILY-resolved safeUpstreamMessage — see runCode's header note. */
  safeUpstreamMessage: (e: UpstreamError) => string
  /** Wire-name arity: true for prefixed (`<profile>__<ns>__<tool>`) multi-profile/global-key facades. */
  prefixed?: boolean
  opts?: Partial<ExecuteOpts>
}

/**
 * Convenience entry point for the cli/mcp-server slices (33c/33d): builds a
 * QuickJsExecutor and runs `code` once against `invoker`. Callers that need
 * to reuse the executor across many executions (e.g. a long-lived MCP
 * server process, where the WASM module load cost should be paid once)
 * should construct `QuickJsExecutor` directly instead and call `.execute()`
 * repeatedly — this wrapper always builds a fresh executor.
 *
 * `safeUpstreamMessage` is threaded in BY THE CALLER (not imported here)
 * so this package never statically imports `@junction/mcp-server` — a
 * CLI-only `junction run` invocation that never touches the MCP server
 * should not eagerly load it. The caller (cli/mcp-server) does the lazy
 * `await import("@junction/mcp-server")` once and passes the function down.
 */
export async function runCode(
  code: string,
  invoker: ToolInvoker,
  options: RunCodeOptions,
): Promise<Result<ExecuteResult, CodeModeError>> {
  const executor: CodeExecutor = new QuickJsExecutor({
    sink: options.sink,
    principal: options.principal,
    profile: options.profile,
    safeUpstreamMessage: options.safeUpstreamMessage,
    prefixed: options.prefixed ?? false,
  })
  return executor.execute(code, invoker, options.opts)
}
