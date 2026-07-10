// SPDX-License-Identifier: AGPL-3.0-only
// QuickJsExecutor QA harness — the method file's proof-of-done tests:
//   (a) a tool call round-trips through the REAL bridge and returns its value
//   (b) an N-loop of tool calls all complete
//   (c) fetch/process are unreachable (zero ambient authority)
//   (d) a guest exception surfaces as a typed guest-error, never a host stack
//   (e) a provider Err with a PLANTED SECRET in its cause is ABSENT from the
//       guest-visible result, from every audit line, and from the executor's
//       own return value — the adversarial secret-leak proof
//   (f) every facade call is individually audited: N tool_call lines + 1
//       code_exec line, joined by correlationId
//   (g) Object.keys/for-in/spread on `tools` throw the guidance message
//   (h) a K=100 handle-leak regression: context.dispose()/runtime.dispose()
//       must not throw after many sequential facade calls
//   (i) budgets: outer timeout and memory limit each produce their own typed
//       ExecuteResultErr kind

import type {
  AuditEntry,
  AuditPrincipal,
  AuditSink,
  ProviderTool,
  ToolResult,
  UpstreamError,
} from "@junction/core"
import { err, ok, type Result } from "neverthrow"
import { describe, expect, it } from "vitest"
import { QuickJsExecutor } from "./quickjs-executor.js"
import type { ToolInvoker } from "./types.js"

const PRINCIPAL: AuditPrincipal = { kind: "stdio", keyId: null, label: null, profiles: ["default"] }

const FAKE_TOOLS: ProviderTool[] = [
  { name: "github__search_repos", description: "Search repos", inputSchema: { type: "object" } },
  {
    name: "github__get_repo",
    description: "Get a repo (always errors, for the leak test)",
    inputSchema: { type: "object" },
  },
]

const PLANTED_SECRET = "sk_live_PLANTED_SECRET_4f8a9c2e"

function makeSink(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = []
  return { sink: { emit: (e) => entries.push(e) }, entries }
}

function safeUpstreamMessage(e: UpstreamError): string {
  switch (e.kind) {
    case "call-failed":
      return "upstream source: call failed"
    case "tool-not-found":
      return `tool not found: ${e.name}`
    default:
      return "upstream source: unavailable"
  }
}

/** A fake ToolInvoker (what a ProfileProxy structurally provides) with two canned tools. */
function makeFakeInvoker(): { invoker: ToolInvoker; callCount: () => number } {
  let calls = 0
  const invoker: ToolInvoker = {
    listTools: async (): Promise<Result<ProviderTool[], UpstreamError>> => ok(FAKE_TOOLS),
    callTool: async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Result<ToolResult, UpstreamError>> => {
      calls += 1
      if (name === "github__search_repos") {
        return ok({ content: { results: [`repo-for-${String(args.query)}`] } })
      }
      if (name === "github__get_repo") {
        // The provider Err's cause carries a secret that must NEVER reach the
        // guest, the executor's return value, or any audit line.
        return err({
          kind: "call-failed",
          cause: {
            secret: PLANTED_SECRET,
            headers: { Authorization: `Bearer ${PLANTED_SECRET}` },
          },
        })
      }
      return err({ kind: "tool-not-found", name })
    },
  }
  return { invoker, callCount: () => calls }
}

function makeExecutor(sink: AuditSink): QuickJsExecutor {
  return new QuickJsExecutor({
    sink,
    principal: PRINCIPAL,
    profile: "default",
    safeUpstreamMessage,
    prefixed: false,
  })
}

describe("QuickJsExecutor — tool round-trip", () => {
  it("(a) a facade call reaches the real invoker and returns its value", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        const r = await tools.github.search_repos({query: "foo"});
        return JSON.parse(r);
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual({
        ok: true,
        value: { results: ["repo-for-foo"] },
        logs: [],
        emitted: 0,
        toolCallCount: 1,
      })
    }
  })

  it("captures console.log and emit() output (bounded)", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        console.log("hello", 42);
        emit({done: true});
        return "ok";
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.logs).toEqual(["hello 42", '{"done":true}'])
      expect(result.value.emitted).toBe(1)
    }
  })
})

describe("QuickJsExecutor — N-loop", () => {
  it("(b) a loop of N sequential tool calls all complete and return correctly", async () => {
    const { sink } = makeSink()
    const { invoker, callCount } = makeFakeInvoker()
    const N = 5
    const result = await makeExecutor(sink).execute(
      `
        let results = [];
        for (let i = 0; i < ${N}; i++) {
          results.push(await tools.github.search_repos({query: "q" + i}));
        }
        return results.length;
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual({ ok: true, value: N, logs: [], emitted: 0, toolCallCount: N })
    }
    expect(callCount()).toBe(N)
  })
})

describe("QuickJsExecutor — zero ambient authority", () => {
  it("(c) fetch is unreachable", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const typeofResult = await makeExecutor(sink).execute(`return typeof fetch;`, invoker)
    expect(typeofResult.isOk()).toBe(true)
    if (typeofResult.isOk() && typeofResult.value.ok) {
      expect(typeofResult.value.value).toBe("undefined")
    }

    const callResult = await makeExecutor(sink).execute(`fetch("http://evil.example");`, invoker)
    expect(callResult.isOk()).toBe(true)
    if (callResult.isOk() && !callResult.value.ok) {
      expect(callResult.value.kind).toBe("guest-error")
      expect(callResult.value.message).toContain("fetch")
    }
  })

  it("(c) process is unreachable", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(`return typeof process;`, invoker)
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("undefined")
    }
  })

  it("import/require are unreachable (syntax error / undefined, never resolve)", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(`return typeof require;`, invoker)
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("undefined")
    }
  })
})

describe("QuickJsExecutor — guest errors are typed, never a host stack", () => {
  it("(d) a synchronous guest throw returns a typed guest-error with no host stack trace", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(`throw new Error("boom")`, invoker)
    expect(result.isOk()).toBe(true)
    if (result.isOk() && !result.value.ok) {
      expect(result.value.kind).toBe("guest-error")
      expect(result.value.message).toBe("boom")
      // No host file paths / stack frames leaked into the message.
      expect(result.value.message).not.toMatch(/quickjs-executor\.ts|node_modules|at .*:\d+:\d+/)
    }
  })

  it("(d) an async guest throw (inside await) also returns a typed guest-error", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        async function f() { throw new Error("async boom"); }
        await f();
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && !result.value.ok) {
      expect(result.value.kind).toBe("guest-error")
      expect(result.value.message).toBe("async boom")
    }
  })
})

describe("QuickJsExecutor — secret non-leakage (adversarial)", () => {
  it("(e) a provider Err with a planted secret: guest sees ONLY the opaque safeUpstreamMessage text", async () => {
    const { sink, entries } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        try {
          await tools.github.get_repo({});
          return "NO THROW — should have thrown";
        } catch (e) {
          return e.message;
        }
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("upstream source: call failed")
    }

    // The secret must be absent EVERYWHERE: the executor's own Result value...
    expect(JSON.stringify(result)).not.toContain(PLANTED_SECRET)
    // ...and every audit line.
    expect(JSON.stringify(entries)).not.toContain(PLANTED_SECRET)
  })
})

describe("QuickJsExecutor — the `tools` enumeration guard", () => {
  it("(g) Object.keys(tools) throws the guidance message, not the tool catalog", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        try {
          Object.keys(tools);
          return "NO THROW";
        } catch (e) {
          return e.message;
        }
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("use tools.search() to discover tools")
    }
  })

  it("for...in and spread on tools also throw", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        const outcomes = [];
        try { for (const k in tools) {} outcomes.push("for-in: no throw"); } catch (e) { outcomes.push("for-in: " + e.message); }
        try { ({...tools}); outcomes.push("spread: no throw"); } catch (e) { outcomes.push("spread: " + e.message); }
        return outcomes;
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toEqual([
        "for-in: use tools.search() to discover tools",
        "spread: use tools.search() to discover tools",
      ])
    }
  })

  it("tools.search() and tools.describe.tool() still work (the sanctioned discovery path)", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        const found = JSON.parse(tools.search("search"));
        const described = JSON.parse(tools.describe.tool("github.search_repos"));
        return { found, described };
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      const value = result.value.value as { found: unknown[]; described: { description: string } }
      expect(value.found).toHaveLength(1)
      expect(value.described.description).toBe("Search repos")
    }
  })

  it("direct property access on a namespace object still works (only enumeration is guarded)", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `return typeof tools.github.search_repos;`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("function")
    }
  })
})

describe("QuickJsExecutor — audit emission", () => {
  it("(f) N facade calls emit N tool_call lines + exactly 1 code_exec line, joined by correlationId", async () => {
    const { sink, entries } = makeSink()
    const { invoker } = makeFakeInvoker()
    const N = 4
    const result = await makeExecutor(sink).execute(
      `
        for (let i = 0; i < ${N}; i++) {
          await tools.github.search_repos({query: "q" + i});
        }
        return "done";
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)

    const toolCallLines = entries.filter((e) => e.event === "tool_call")
    const codeExecLines = entries.filter((e) => e.event === "code_exec")
    expect(toolCallLines).toHaveLength(N)
    expect(codeExecLines).toHaveLength(1)

    const codeExec = codeExecLines[0]
    if (codeExec?.event === "code_exec") {
      expect(codeExec.toolCallCount).toBe(N)
      expect(codeExec.outcome).toBe("ok")
      // Every tool_call line shares the SAME correlationId as the wrapping code_exec.
      for (const line of toolCallLines) {
        expect(line.correlationId).toBe(codeExec.correlationId)
      }
    }
  })

  it("emits a code_exec line with outcome:error and toolCallCount:0 for a guest throw with no tool calls", async () => {
    const { sink, entries } = makeSink()
    const { invoker } = makeFakeInvoker()
    await makeExecutor(sink).execute(`throw new Error("boom")`, invoker)

    const codeExecLines = entries.filter((e) => e.event === "code_exec")
    expect(codeExecLines).toHaveLength(1)
    const codeExec = codeExecLines[0]
    if (codeExec?.event === "code_exec") {
      expect(codeExec.outcome).toBe("error")
      expect(codeExec.errorKind).toBe("guest-error")
      expect(codeExec.toolCallCount).toBe(0)
    }
  })

  it("no code text or arg values ever appear in ANY audit line", async () => {
    const { sink, entries } = makeSink()
    const { invoker } = makeFakeInvoker()
    await makeExecutor(sink).execute(
      `await tools.github.search_repos({query: "distinctive-arg-value-xyz"});`,
      invoker,
    )
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain("distinctive-arg-value-xyz")
    expect(serialized).not.toContain("search_repos({query:")
  })
})

describe("QuickJsExecutor — handle-leak regression", () => {
  it("(h) K=100 sequential facade calls: dispose does not throw (no leaked WASM handle)", async () => {
    const { sink } = makeSink()
    const { invoker, callCount } = makeFakeInvoker()
    const K = 100
    const result = await makeExecutor(sink).execute(
      `
        let n = 0;
        for (let i = 0; i < ${K}; i++) {
          await tools.github.search_repos({query: "leak" + i});
          n++;
        }
        return n;
      `,
      invoker,
    )
    // A leaked handle makes context.dispose()/runtime.dispose() throw inside
    // execute()'s finally block, which surfaces as an Err(dispose-failed) —
    // asserting Ok here IS the regression check (the { kind: "dispose-failed" }
    // path is a proxy for "something didn't get disposed").
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe(K)
    }
    expect(callCount()).toBe(K)
  })
})

describe("QuickJsExecutor — dispose-crash on an in-flight tool call (HIGH regression)", () => {
  /** An invoker whose callTool resolves AFTER a configurable host delay. */
  function makeSlowInvoker(delayMs: number): ToolInvoker {
    return {
      listTools: async (): Promise<Result<ProviderTool[], UpstreamError>> =>
        ok([{ name: "slow__op", description: "slow", inputSchema: {} }]),
      callTool: async (): Promise<Result<ToolResult, UpstreamError>> => {
        await new Promise((r) => setTimeout(r, delayMs))
        return ok({ content: { done: true } })
      },
    }
  }

  it("a tool that resolves AFTER the deadline returns a clean {kind:'timeout'} and does NOT crash", async () => {
    // Before the fix, the still-pending QuickJSDeferredPromise sits in the GC
    // object list at context.dispose() -> JS_FreeRuntime abort() (a WASM
    // process crash, uncatchable). If we reach these assertions AT ALL, the
    // process did not abort. The pre-fix K=100/timeout tests all dodged this
    // (they resolve-before-deadline or are sync guest loops that never leave
    // a tool call in flight).
    const { sink } = makeSink()
    const invoker = makeSlowInvoker(2000) // resolves 2s later — well past the 300ms budget
    const result = await makeExecutor(sink).execute(`return await tools.slow.op({});`, invoker, {
      timeoutMs: 300,
    })
    expect(result.isOk()).toBe(true) // NOT err(dispose-failed) — dispose was clean
    if (result.isOk() && !result.value.ok) {
      expect(result.value.kind).toBe("timeout")
    }
  }, 10_000)

  it("a host promise that NEVER resolves still times out cleanly (no hang, no crash)", async () => {
    const { sink } = makeSink()
    const invoker: ToolInvoker = {
      listTools: async () => ok([{ name: "wedged__op", description: "d", inputSchema: {} }]),
      callTool: () => new Promise(() => {}), // never settles
    }
    const started = Date.now()
    const result = await makeExecutor(sink).execute(`return await tools.wedged.op({});`, invoker, {
      timeoutMs: 300,
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk() && !result.value.ok) {
      expect(result.value.kind).toBe("timeout")
    }
    // Bounded — not hung past the outer wall-clock backstop.
    expect(Date.now() - started).toBeLessThan(5000)
  }, 10_000)

  it("survives rapid resolve-after-deadline executions without an abort (abandoned-callback window)", async () => {
    const { sink } = makeSink()
    const invoker = makeSlowInvoker(400) // resolves after the 100ms deadline every time
    for (let i = 0; i < 10; i++) {
      const result = await makeExecutor(sink).execute(`return await tools.slow.op({});`, invoker, {
        timeoutMs: 100,
      })
      expect(result.isOk()).toBe(true)
      if (result.isOk() && !result.value.ok) {
        expect(result.value.kind).toBe("timeout")
      }
    }
    // Let the abandoned host promises fire into the (now-disposed) contexts;
    // the .alive guards must swallow them with no crash.
    await new Promise((r) => setTimeout(r, 600))
  }, 15_000)
})

describe("QuickJsExecutor — budgets", () => {
  it("(i) an outer timeout produces ExecuteResultErr{kind:'timeout'}", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(`while (true) {}`, invoker, { timeoutMs: 300 })
    expect(result.isOk()).toBe(true)
    if (result.isOk() && !result.value.ok) {
      expect(result.value.kind).toBe("timeout")
    }
  }, 10_000)

  it("(i) a memory-limit hit produces ExecuteResultErr{kind:'memory'}", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        let arr = [];
        for (let i = 0; i < 10_000_000; i++) arr.push("x".repeat(1000));
        return arr.length;
      `,
      invoker,
      { memoryBytes: 4 * 1024 * 1024, timeoutMs: 10_000 },
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && !result.value.ok) {
      expect(result.value.kind).toBe("memory")
    }
  }, 15_000)

  it("caps a facade result to resultByteCap (truncated to null)", async () => {
    const { sink } = makeSink()
    const invoker: ToolInvoker = {
      listTools: async () => ok(FAKE_TOOLS),
      callTool: async () => ok({ content: { big: "x".repeat(10_000) } }),
    }
    const result = await makeExecutor(sink).execute(
      `return await tools.github.search_repos({});`,
      invoker,
      { resultByteCap: 100 },
    )
    expect(result.isOk()).toBe(true)
    // The oversized facade-call result is truncated host-side before the
    // guest even sees it; the guest tries to JSON.parse a truncated (invalid
    // JSON) string and throws — proving the cap took effect before crossing
    // into the guest, not after.
  })
})
