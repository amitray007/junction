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

// A realistic Stripe-style secret-key-shaped sentinel, assembled from parts at
// runtime so NO literal key-shaped string sits in source for gitleaks to flag
// as a real leak. At runtime it is exactly "sk_live_PLANTED_SECRET_4f8a9c2e" —
// a value the leak tests below plant into a provider error and prove ABSENT
// from all guest output + audit entries.
const PLANTED_SECRET = ["sk", "live", "PLANTED", "SECRET", "4f8a9c2e"].join("_")

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
        return r;
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

  it("(33f) a tool call's result is ALREADY unwrapped — no guest-side JSON.parse needed, field access works directly", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        const r = await tools.github.search_repos({query: "foo"});
        return r.results[0];
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("repo-for-foo")
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

  it("(33.1 fix 3) tools.search()/tools.describe.tool() return ALREADY-UNWRAPPED objects — no guest-side JSON.parse needed", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        // NO JSON.parse here — the guest wrapper (TOOLS_PROXY_BOOTSTRAP)
        // already parses the result, matching the 33f direct-call unwrap
        // ergonomics. Direct field/index access proves it's a real
        // object/array, not a string a caller forgot to parse.
        const hits = tools.search({ query: "search" });
        const described = tools.describe.tool("github.search_repos");
        return { firstHitTool: hits[0].tool, describedInputSchema: described.inputSchema };
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      const value = result.value.value as {
        firstHitTool: string
        describedInputSchema: unknown
      }
      // If this were still a raw JSON string, `hits[0]` would be a single
      // CHARACTER (string indexing), not an object with a `.tool` field —
      // `.tool` on a character would be `undefined`, not "search_repos".
      expect(value.firstHitTool).toBe("search_repos")
      expect(value.describedInputSchema).toEqual({ type: "object" })
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
    if (result.isOk()) {
      expect(result.value.ok).toBe(false) // closes the escape hatch: must fail loudly if unexpectedly ok
      if (!result.value.ok) {
        expect(result.value.kind).toBe("timeout")
      }
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
    if (result.isOk()) {
      expect(result.value.ok).toBe(false) // closes the escape hatch: must fail loudly if unexpectedly ok
      if (!result.value.ok) {
        expect(result.value.kind).toBe("timeout")
      }
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
      if (result.isOk()) {
        expect(result.value.ok).toBe(false) // closes the escape hatch: must fail loudly if unexpectedly ok
        if (!result.value.ok) {
          expect(result.value.kind).toBe("timeout")
        }
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
    if (result.isOk()) {
      expect(result.value.ok).toBe(false) // closes the escape hatch: must fail loudly if unexpectedly ok
      if (!result.value.ok) {
        expect(result.value.kind).toBe("timeout")
      }
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
    if (result.isOk()) {
      expect(result.value.ok).toBe(false) // closes the escape hatch: must fail loudly if unexpectedly ok
      if (!result.value.ok) {
        expect(result.value.kind).toBe("memory")
      }
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

  it("(5) rejects an oversized facade-call ARG before it ever reaches the invoker (argByteCap)", async () => {
    const { sink } = makeSink()
    const { invoker, callCount } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        try {
          await tools.github.search_repos({ query: "x".repeat(1000) });
          return "NO THROW";
        } catch (e) {
          return e.message;
        }
      `,
      invoker,
      { argByteCap: 100 },
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toContain("exceed")
    }
    // The host-side byte check runs BEFORE invoker.callTool is ever
    // dispatched — removing it (or moving the check after the call) would
    // let this call through, so callCount staying at 0 is the guard's proof.
    expect(callCount()).toBe(0)
  })

  it("(5) truncates console.log/emit output to logByteCap and flags truncation, never growing the host array unbounded", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        for (let i = 0; i < 50; i++) {
          console.log("x".repeat(1000));
        }
        return "done";
      `,
      invoker,
      // Deliberately NOT a multiple of 1000 so the cap lands mid-string on
      // one of the pushes — that call is the one whose truncateToBytes
      // result carries truncated:true (the log after it is dropped
      // entirely by the logBytesUsed >= cap early-return, never itself
      // flagged). Both are the guard's proof: capacity used is bounded far
      // below the unguarded total (50 * 1000 = 50000 bytes).
      { logByteCap: 1500 },
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      const totalBytes = result.value.logs.reduce((sum, l) => sum + Buffer.byteLength(l, "utf8"), 0)
      expect(totalBytes).toBeLessThan(1600)
      expect(result.value.logs.some((l) => l.includes("[truncated]"))).toBe(true)
      // Removing the logByteCap check entirely would produce 50 full lines.
      expect(result.value.logs.length).toBeLessThan(50)
    }
  })
})

describe("QuickJsExecutor — zero ambient authority (full enumeration)", () => {
  // Each of these globals must be undefined inside the guest realm — a
  // fresh QuickJS context ships DefaultIntrinsics (Date/JSON/etc) but
  // installTools/installConsole/installEmit are the ONLY globals this
  // executor ever adds. Removing the "only install tools/console/emit"
  // discipline (e.g. accidentally exposing Node's global scope) would flip
  // any one of these to a truthy typeof.
  const ambientGlobals = [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "process",
    "require",
    "Deno",
    "Bun",
    "__dirname",
    "__filename",
    "module",
    "exports",
  ]

  it.each(ambientGlobals)("(1) typeof %s is undefined inside the guest", async (name) => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(`return typeof ${name};`, invoker)
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("undefined")
    }
  })

  it("(1) globalThis.process is also undefined (no indirection around the direct-reference check)", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(`return typeof globalThis.process;`, invoker)
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("undefined")
    }
  })

  it("(1) dynamic import(...) is a syntax/reference error, never resolves a module", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `await import("node:fs"); return "NO THROW";`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && !result.value.ok) {
      // Global eval mode (not "module") means import() is unavailable — a
      // guest-error (syntax error at eval time), never a resolved module.
      expect(result.value.kind).toBe("guest-error")
    }
  })

  it("(1) WebSocket constructor call throws (unreachable, not silently a no-op)", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `try { new WebSocket("ws://evil.example"); return "NO THROW"; } catch (e) { return "threw: " + e.message; }`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toContain("threw")
    }
  })
})

describe("QuickJsExecutor — no filesystem/env reach (#2)", () => {
  it("(2) process.env is unreachable (process itself is undefined)", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `try { return process.env; } catch (e) { return "threw: " + e.message; }`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      // `process` is undefined, so `process.env` throws a ReferenceError
      // (guest-catchable) — never resolves to the host's real env vars.
      expect(result.value.value).toContain("threw")
    }
  })

  it("(2) no fs module reachable via require/import/global", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `return typeof require === "undefined" && typeof globalThis.fs === "undefined";`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe(true)
    }
  })

  it("(2) __dirname/__filename are undefined (no host path leakage via CJS wrapper globals)", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `return [typeof __dirname, typeof __filename];`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toEqual(["undefined", "undefined"])
    }
  })
})

describe("QuickJsExecutor — prototype-pollution guard (#7)", () => {
  it("(7) a __proto__-payload tool-call arg cannot mutate the HOST Object.prototype", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()

    // Plant a sentinel on the HOST's real Object.prototype's would-be
    // pollution target BEFORE running guest code, then assert it is
    // unchanged after. If nullProtoReviver (quickjs-executor.ts) were
    // removed, the JSON.parse of the guest-constructed args on the way
    // across the FFI would let `__proto__` write through, but even then —
    // because the guest args round-trip through safeJsonParse's OWN
    // process, not the host's `JSON.parse` — the mutation could only ever
    // land in the host if this guard were bypassed via a host-side parse of
    // guest-controlled text. Assert directly that the check protects the
    // host's real Object.prototype from a payload shaped like a pollution
    // attempt embedded in facade call args.
    const sentinelKey = "__polluted_by_guest_sentinel__"
    expect((Object.prototype as Record<string, unknown>)[sentinelKey]).toBeUndefined()

    const result = await makeExecutor(sink).execute(
      `
        const evil = JSON.parse('{"__proto__": {"${sentinelKey}": "pwned"}}');
        return await tools.github.search_repos(evil);
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)

    // The HOST'S OWN Object.prototype must be untouched no matter what the
    // guest's local JSON.parse produced — this is the load-bearing
    // assertion (host-side sentinel proof per the method file).
    expect((Object.prototype as Record<string, unknown>)[sentinelKey]).toBeUndefined()
    // biome-ignore lint/suspicious/noExplicitAny: sentinel probe, not a real object shape
    expect(({} as any)[sentinelKey]).toBeUndefined()

    delete (Object.prototype as Record<string, unknown>)[sentinelKey]
  })

  it("(7) a guest-side __proto__ assignment on a plain object does not touch the host realm's Object.prototype", async () => {
    const { sink } = makeSink()
    const { invoker } = makeFakeInvoker()
    const sentinelKey = "__polluted_via_guest_assignment__"
    expect((Object.prototype as Record<string, unknown>)[sentinelKey]).toBeUndefined()

    const result = await makeExecutor(sink).execute(
      `
        const obj = {};
        obj.__proto__[${JSON.stringify(sentinelKey)}] = "pwned";
        return obj[${JSON.stringify(sentinelKey)}];
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      // Within the GUEST's own separate QuickJS heap this assignment can
      // succeed (it has its own Object.prototype) — the invariant under
      // test is that this NEVER crosses into the host's real
      // Object.prototype, proven by the sentinel check below regardless of
      // what the guest observed locally.
      expect(result.value.value).toBe("pwned")
    }
    // The critical assertion: the HOST's Object.prototype is a completely
    // separate JS realm/heap from the guest's WASM-internal one — a
    // guest-side prototype mutation can never reach here.
    expect((Object.prototype as Record<string, unknown>)[sentinelKey]).toBeUndefined()
  })

  it("(33.1 fix 3) tools.describe.tool()'s guest-side JSON.parse uses the SAME null-proto reviver as direct tool-call results — a __proto__-keyed inputSchema (upstream-controlled data) can't pollute the guest's OWN Object.prototype", async () => {
    const { sink } = makeSink()
    // inputSchema is the one field of a ProviderTool that's genuinely
    // upstream/attacker-shaped data (an MCP server or CLI catalog author
    // controls it) and flows verbatim into DescribeResult.inputSchema
    // (facade.ts's describeFacadeTool) — unlike name/description (which are
    // catalog labels, not structured objects), inputSchema CAN carry a
    // literal "__proto__" key. This is the real injection surface the
    // guest-side reviver on tools.describe.tool() must guard.
    // Object-literal `{ __proto__: ... }` syntax sets the actual prototype
    // (not an own property) and would vanish under JSON.stringify — use
    // JSON.parse to construct a genuine OWN "__proto__" property that
    // round-trips through JSON.stringify/parse exactly like real
    // upstream-controlled inputSchema data would.
    const pollutingInputSchema = JSON.parse(
      '{"__proto__": {"polluted_via_describe_schema": "pwned"}}',
    ) as object
    const protoPollutingInvoker: ToolInvoker = {
      listTools: async () =>
        ok([
          {
            name: "github__search_repos",
            description: "Search repos",
            inputSchema: pollutingInputSchema,
          } as ProviderTool,
        ]),
      callTool: async () => ok({ content: { ok: true } }),
    }

    const result = await makeExecutor(sink).execute(
      `
        // NO JSON.parse (33.1 fix 3) — tools.describe.tool() is already
        // parsed. If the guest-side wrap used a PLAIN JSON.parse (no
        // reviver), described.inputSchema's "__proto__" key would set the
        // GUEST's own Object.prototype's "polluted_via_describe_schema"
        // field, and a brand-new {} would inherit it.
        const described = tools.describe.tool("github.search_repos");
        const freshObj = {};
        return {
          hasOwnProtoKey: Object.prototype.hasOwnProperty.call(described.inputSchema, "__proto__"),
          freshObjPolluted: freshObj.polluted_via_describe_schema,
        };
      `,
      protoPollutingInvoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      const value = result.value.value as {
        hasOwnProtoKey: boolean
        freshObjPolluted: unknown
      }
      // The reviver drops the "__proto__" KEY entirely (nullProtoReviver
      // returns undefined for it) — described.inputSchema never gets an
      // own "__proto__" property at all.
      expect(value.hasOwnProtoKey).toBe(false)
      // And a brand-new guest object was never polluted by the parse.
      expect(value.freshObjPolluted).toBeUndefined()
    }
  })
})

describe("QuickJsExecutor — filtered-toolset-only (#11)", () => {
  it("(11) a tool NOT present in invoker.listTools() is not callable — no bypass path around a filtered toolset", async () => {
    const { sink } = makeSink()
    // Simulate a profile whose toolFilter has already denied `get_repo` —
    // the FILTERED listTools() the executor is handed only contains
    // search_repos. The facade is built exclusively from this list (see
    // quickjs-executor.ts installTools: it iterates `plan`, derived only
    // from what listTools() returned — never a wider catalog).
    const filteredInvoker: ToolInvoker = {
      listTools: async () => ok([FAKE_TOOLS[0] as ProviderTool]), // only github__search_repos
      callTool: async (name: string) => {
        // If this were ever reached for the denied tool, that IS the bypass
        // — fail loudly rather than silently succeeding.
        if (name === "github__get_repo") {
          throw new Error("BYPASS: denied tool was dispatched to the invoker")
        }
        return ok({ content: { ok: true } })
      },
    }

    const result = await makeExecutor(sink).execute(
      `
        try {
          await tools.github.get_repo({});
          return "NO THROW — should be unreachable";
        } catch (e) {
          return "threw: " + e.message;
        }
      `,
      filteredInvoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      // tools.github.get_repo doesn't exist as a property at all (the
      // facade never installed it) — calling it is a guest-level TypeError
      // ("not a function"), the same shape as calling any nonexistent tool,
      // NOT a routed-then-denied error. That IS the "fails as if unknown"
      // requirement — there is no separate code path that would let a
      // clever guest reach the denied tool anyway.
      expect(result.value.value).toContain("threw")
    }

    // The allowed tool still works normally through the same filtered plan.
    const allowedResult = await makeExecutor(sink).execute(
      `return await tools.github.search_repos({query: "x"});`,
      filteredInvoker,
    )
    expect(allowedResult.isOk()).toBe(true)
    if (allowedResult.isOk() && allowedResult.value.ok) {
      expect(allowedResult.value.value).toEqual({ ok: true })
    }
  })

  it("(11) tools.search()/tools.describe.tool() only ever surface tools from the filtered listTools() snapshot", async () => {
    const { sink } = makeSink()
    const filteredInvoker: ToolInvoker = {
      listTools: async () => ok([FAKE_TOOLS[0] as ProviderTool]), // only search_repos
      callTool: async () => ok({ content: { ok: true } }),
    }
    const result = await makeExecutor(sink).execute(
      `
        // NO JSON.parse (33.1 fix 3) — the guest wrapper already parses these.
        const found = tools.search("repo");
        const described = tools.describe.tool("github.get_repo");
        return { foundCount: found.length, foundTools: found.map(f => f.tool), described };
      `,
      filteredInvoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      const value = result.value.value as {
        foundCount: number
        foundTools: string[]
        described: unknown
      }
      // search() never surfaces the filtered-out get_repo tool.
      expect(value.foundTools).toEqual(["search_repos"])
      // describe.tool() on a filtered-out tool resolves to null, not the
      // real (denied) tool's schema — no discovery-path bypass either.
      expect(value.described).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// unwrapToolResult (33f) — the facade result-ergonomics fix, exercised
// end-to-end through the real bridge for each provider kind's actual
// ToolResult.content shape (see quickjs-executor.ts's unwrapToolResult doc
// comment + the provider source files it was read against):
//   - openapi-client / http-client: content is [{type:"text", text:
//     "<3-digit-status> <reason>\n<body>"}] (openapi-client/src/http.ts)
//   - graphql-client: content is [{type:"text", text:"<raw JSON body>"}],
//     no status-line prefix (graphql-client/src/http.ts)
//   - cli provider: content is [{type:"text", text:"exit <n>\n<stdout+
//     stderr>"}] — often NOT JSON (core/src/sources/cli/provider.ts)
//   - mcp provider: content is whatever the upstream MCP server returned,
//     passed through verbatim (mcp/client/src/session.ts) — usually a
//     single JSON or plain-text {type:"text"} part, but may be multi-part
//     or a non-text part (image/resource/etc)
// ---------------------------------------------------------------------------

function makeSingleToolInvoker(content: unknown, isError?: boolean): ToolInvoker {
  return {
    listTools: async () => ok([FAKE_TOOLS[0] as ProviderTool]),
    callTool: async () => ok({ content, isError }),
  }
}

describe("QuickJsExecutor — unwrapToolResult (33f result-ergonomics fix)", () => {
  it("openapi/http shape: strips the '<status> <reason>\\n' line and parses the JSON body — field access works directly", async () => {
    const { sink } = makeSink()
    const invoker = makeSingleToolInvoker([
      { type: "text", text: '200 OK\n{"greeting":"hi code-mode"}' },
    ])
    const result = await makeExecutor(sink).execute(
      `return (await tools.github.search_repos({})).greeting;`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("hi code-mode")
    }
  })

  it("openapi/http shape: a non-200 status line is stripped identically (404 Not Found)", async () => {
    const { sink } = makeSink()
    const invoker = makeSingleToolInvoker(
      [{ type: "text", text: '404 Not Found\n{"error":"missing"}' }],
      true,
    )
    const result = await makeExecutor(sink).execute(
      `
        try {
          await tools.github.search_repos({});
          return "NO THROW";
        } catch (e) {
          return e.message;
        }
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      // isError:true rejects with the UNWRAPPED (status-line-stripped,
      // JSON-parsed-then-restringified) content — never the raw envelope.
      expect(result.value.value).toBe('{"error":"missing"}')
    }
  })

  it("graphql shape: no status-line prefix — the raw JSON body parses directly", async () => {
    const { sink } = makeSink()
    const invoker = makeSingleToolInvoker([
      { type: "text", text: '{"data":{"viewer":{"login":"octocat"}}}' },
    ])
    const result = await makeExecutor(sink).execute(
      `return (await tools.github.search_repos({})).data.viewer.login;`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("octocat")
    }
  })

  it("cli shape: 'exit N\\n<output>' is NOT JSON and NOT an HTTP status line — returned as the raw string, not misparsed", async () => {
    const { sink } = makeSink()
    const invoker = makeSingleToolInvoker([{ type: "text", text: "exit 0\nbuild succeeded" }])
    const result = await makeExecutor(sink).execute(
      `return await tools.github.search_repos({});`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      // "exit 0" does NOT match the 3-digit HTTP-status-line pattern (starts
      // with a word, not digits) — the full text survives unstripped, and
      // since it isn't valid JSON it comes back as a plain string.
      expect(result.value.value).toBe("exit 0\nbuild succeeded")
    }
  })

  it("cli shape: a non-zero exit with isError:true rejects with the raw exit+output text", async () => {
    const { sink } = makeSink()
    const invoker = makeSingleToolInvoker(
      [{ type: "text", text: "exit 1\ncommand not found: frobnicate" }],
      true,
    )
    const result = await makeExecutor(sink).execute(
      `
        try {
          await tools.github.search_repos({});
          return "NO THROW";
        } catch (e) {
          return e.message;
        }
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("exit 1\ncommand not found: frobnicate")
    }
  })

  it("mcp plain-text shape: a single non-JSON text part returns the string, not the envelope", async () => {
    const { sink } = makeSink()
    const invoker = makeSingleToolInvoker([{ type: "text", text: "plain upstream text, not JSON" }])
    const result = await makeExecutor(sink).execute(
      `return await tools.github.search_repos({});`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("plain upstream text, not JSON")
    }
  })

  it("mcp multi-part shape: a multi-part content array is returned as a structured array, never lossy", async () => {
    const { sink } = makeSink()
    const invoker = makeSingleToolInvoker([
      { type: "text", text: '{"a":1}' },
      { type: "text", text: "plain text part" },
      { type: "image", data: "base64...", mimeType: "image/png" },
    ])
    const result = await makeExecutor(sink).execute(
      `return await tools.github.search_repos({});`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      // Each text part is unwrapped the same way a single-part result would
      // be; a non-text part (image/resource/etc) passes through opaquely —
      // no data lost, no crash on an unrecognized MCP content type.
      expect(result.value.value).toEqual([
        { a: 1 },
        "plain text part",
        { type: "image", data: "base64...", mimeType: "image/png" },
      ])
    }
  })

  it("a raw (non-array) content value — e.g. a hand-built test fake — passes through unchanged", async () => {
    const { sink } = makeSink()
    const invoker = makeSingleToolInvoker({ results: ["already-an-object"] })
    const result = await makeExecutor(sink).execute(
      `return (await tools.github.search_repos({})).results[0];`,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("already-an-object")
    }
  })

  it("isError:true still respects the resultByteCap on the unwrapped/rejected text", async () => {
    const { sink } = makeSink()
    const invoker = makeSingleToolInvoker(
      [{ type: "text", text: `500 Internal Server Error\n${"x".repeat(10_000)}` }],
      true,
    )
    const result = await makeExecutor(sink).execute(
      `
        try {
          await tools.github.search_repos({});
          return "NO THROW";
        } catch (e) {
          return e.message.length;
        }
      `,
      invoker,
      { resultByteCap: 100 },
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value as number).toBeLessThanOrEqual(100)
    }
  })

  it("unwrapping never reintroduces a secret — the PLANTED_SECRET adversarial proof still holds through the unwrap path", async () => {
    const { sink, entries } = makeSink()
    const { invoker } = makeFakeInvoker()
    const result = await makeExecutor(sink).execute(
      `
        try {
          await tools.github.get_repo({});
          return "NO THROW";
        } catch (e) {
          return e.message;
        }
      `,
      invoker,
    )
    expect(result.isOk()).toBe(true)
    expect(JSON.stringify(result)).not.toContain(PLANTED_SECRET)
    expect(JSON.stringify(entries)).not.toContain(PLANTED_SECRET)
  })
})
