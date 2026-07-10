// SPDX-License-Identifier: AGPL-3.0-only
// CLI `junction audit` child-process tests (increment 31, Slice C).
//
// Drives the BUILT junction binary end-to-end against a hand-seeded
// `audit.log` under a temp JUNCTION_HOME (Slice B — the pino sink/hook —
// may not be merged yet, so we can't generate a real log via serving; a
// hand-written JSONL file is the correct seam to unit-test a pure reader).

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { AuditEntry, CodeExecEntry, ToolCallEntry } from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js")
const coreDistMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@junction/core/dist/migrations",
)
const builtBinReady = existsSync(distIndex) && existsSync(coreDistMigrations)

async function run(env: NodeJS.ProcessEnv, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [distIndex, ...args], { env })
    return { stdout, stderr, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 }
  }
}

/** Build a well-formed tool_call AuditEntry with sane defaults, overridable per test. */
function makeEntry(overrides: Partial<ToolCallEntry> = {}): AuditEntry {
  return {
    v: 1,
    ts: "2026-07-01T00:00:00.000Z",
    event: "tool_call",
    correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    principal: { kind: "stdio", keyId: null, label: null, profiles: ["work"] },
    target: { profile: "work", namespace: "github", tool: "search_repos" },
    argKeys: ["query"],
    argHash: "deadbeef",
    durationMs: 12,
    outcome: "ok",
    errorKind: null,
    ...overrides,
  }
}

/** Seed `<home>/audit.log` with the given lines (already-stringified or entries). */
async function seedAuditLog(home: string, lines: Array<AuditEntry | string>): Promise<void> {
  await mkdir(home, { recursive: true })
  const content = `${lines
    .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
    .join("\n")}\n`
  await writeFile(path.join(home, "audit.log"), content, "utf8")
}

describe.skipIf(!builtBinReady)("junction audit (built bin, child process)", () => {
  it("absent file is graceful — human 'no entries yet', --json emits []", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }

      const human = await run(env, ["audit"])
      expect(human.code).toBe(0)
      expect(human.stdout).toContain("No audit entries yet")

      const jsonRes = await run(env, ["audit", "--json"])
      expect(jsonRes.code).toBe(0)
      expect(JSON.parse(jsonRes.stdout.trim())).toEqual([])
    })
  })

  it("--json emits parseable entries matching the seeded log", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const entry = makeEntry()
      await seedAuditLog(home, [entry])

      const result = await run(env, ["audit", "--json"])
      expect(result.code).toBe(0)
      const rows = JSON.parse(result.stdout.trim()) as AuditEntry[]
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject(entry)
    })
  })

  it("a malformed line is skipped (not fatal) and counted in human mode", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const good = makeEntry()
      await seedAuditLog(home, [good, "{not valid json", "{}"])

      const jsonRes = await run(env, ["audit", "--json"])
      expect(jsonRes.code).toBe(0)
      const rows = JSON.parse(jsonRes.stdout.trim()) as AuditEntry[]
      expect(rows).toHaveLength(1)

      const human = await run(env, ["audit"])
      expect(human.code).toBe(0)
      expect(human.stdout).toMatch(/skipped 2 malformed lines/)
    })
  })

  it("--profile filters by target.profile OR membership in principal.profiles", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const workEntry = makeEntry({ target: { profile: "work", namespace: "github", tool: "a" } })
      const personalEntry = makeEntry({
        target: { profile: "personal", namespace: "github", tool: "b" },
        principal: { kind: "api-key", keyId: "k1", label: "L", profiles: ["work", "personal"] },
      })
      const otherEntry = makeEntry({
        target: { profile: "other", namespace: "github", tool: "c" },
        principal: { kind: "api-key", keyId: "k2", label: "L2", profiles: ["other"] },
      })
      await seedAuditLog(home, [workEntry, personalEntry, otherEntry])

      const result = await run(env, ["audit", "--profile", "work", "--json"])
      expect(result.code).toBe(0)
      const rows = JSON.parse(result.stdout.trim()) as AuditEntry[]
      // workEntry matches target.profile; personalEntry matches membership (key scoped to work+personal).
      expect(rows).toHaveLength(2)
      expect(rows.some((r) => r.target.tool === "a")).toBe(true)
      expect(rows.some((r) => r.target.tool === "b")).toBe(true)
      expect(rows.some((r) => r.target.tool === "c")).toBe(false)
    })
  })

  it("--key filters by principal.keyId", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const a = makeEntry({
        principal: { kind: "api-key", keyId: "keyA", label: "A", profiles: ["work"] },
      })
      const b = makeEntry({
        principal: { kind: "api-key", keyId: "keyB", label: "B", profiles: ["work"] },
      })
      await seedAuditLog(home, [a, b])

      const result = await run(env, ["audit", "--key", "keyA", "--json"])
      const rows = JSON.parse(result.stdout.trim()) as AuditEntry[]
      expect(rows).toHaveLength(1)
      expect(rows[0]?.principal.keyId).toBe("keyA")
    })
  })

  it("--tool filters by target.tool", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const a = makeEntry({ target: { profile: "work", namespace: "github", tool: "search" } })
      const b = makeEntry({
        target: { profile: "work", namespace: "github", tool: "create_issue" },
      })
      await seedAuditLog(home, [a, b])

      const result = await run(env, ["audit", "--tool", "create_issue", "--json"])
      const rows = JSON.parse(result.stdout.trim()) as AuditEntry[]
      expect(rows).toHaveLength(1)
      expect(rows[0]?.target.tool).toBe("create_issue")
    })
  })

  it("-n/--limit takes the LAST n entries after filtering", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const entries = [1, 2, 3, 4, 5].map((i) =>
        makeEntry({
          correlationId: `entry-${i}`,
          ts: `2026-07-0${i}T00:00:00.000Z`,
        }),
      )
      await seedAuditLog(home, entries)

      const result = await run(env, ["audit", "-n", "2", "--json"])
      const rows = JSON.parse(result.stdout.trim()) as AuditEntry[]
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.correlationId)).toEqual(["entry-4", "entry-5"])
    })
  })

  it("--since is parsed as ISO-8601 and compared in UTC — a bare date is UTC midnight", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      // Just before UTC midnight on the 2nd, and just after.
      const before = makeEntry({
        correlationId: "before",
        ts: "2026-07-01T23:59:59.000Z",
      })
      const after = makeEntry({
        correlationId: "after",
        ts: "2026-07-02T00:00:01.000Z",
      })
      await seedAuditLog(home, [before, after])

      // Bare date "2026-07-02" must mean UTC midnight, not local midnight —
      // so `before` (23:59:59 UTC on the 1st) must be excluded and `after`
      // (00:00:01 UTC on the 2nd) must be included, regardless of the host's
      // local timezone.
      const result = await run(env, ["audit", "--since", "2026-07-02", "--json"])
      const rows = JSON.parse(result.stdout.trim()) as AuditEntry[]
      expect(rows.map((r) => r.correlationId)).toEqual(["after"])
    })
  })

  it("an invalid --since value fails cleanly instead of matching everything", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      await seedAuditLog(home, [makeEntry()])

      const result = await run(env, ["audit", "--since", "not-a-date", "--json"])
      expect(result.code).not.toBe(0)
    })
  })
})

/** Build a well-formed code_exec AuditEntry (increment 33 Slice A). */
function makeCodeExecEntry(overrides: Partial<CodeExecEntry> = {}): AuditEntry {
  return {
    v: 1,
    ts: "2026-07-01T00:00:00.000Z",
    event: "code_exec",
    correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    principal: { kind: "stdio", keyId: null, label: null, profiles: ["work"] },
    profile: "work",
    durationMs: 240,
    outcome: "ok",
    errorKind: null,
    toolCallCount: 2,
    ...overrides,
  }
}

describe.skipIf(!builtBinReady)(
  "junction audit — code_exec rendering (increment 33 Slice A)",
  () => {
    it("a hand-crafted log with BOTH a tool_call and a code_exec line renders both in human mode", async () => {
      await withTempHome(async (home) => {
        const env = { ...process.env, JUNCTION_HOME: home }
        const toolCall = makeEntry({ correlationId: "shared-id" })
        const codeExec = makeCodeExecEntry({ correlationId: "shared-id" })
        await seedAuditLog(home, [toolCall, codeExec])

        const human = await run(env, ["audit"])
        expect(human.code).toBe(0)
        // tool_call row
        expect(human.stdout).toContain("github__search_repos")
        // code_exec row — no namespace/tool, renders its own label + count
        expect(human.stdout).toContain("code_exec")
        expect(human.stdout).toContain("2 tool calls")
        // NO secret / code text anywhere in the output
        expect(human.stdout).not.toMatch(/console\.log|fetch\(|require\(/)
      })
    })

    it("--json emits both event shapes intact (no target/tool on code_exec)", async () => {
      await withTempHome(async (home) => {
        const env = { ...process.env, JUNCTION_HOME: home }
        const toolCall = makeEntry()
        const codeExec = makeCodeExecEntry()
        await seedAuditLog(home, [toolCall, codeExec])

        const result = await run(env, ["audit", "--json"])
        expect(result.code).toBe(0)
        const rows = JSON.parse(result.stdout.trim()) as AuditEntry[]
        expect(rows).toHaveLength(2)
        const tc = rows.find((r) => r.event === "tool_call")
        const ce = rows.find((r) => r.event === "code_exec")
        expect(tc).toBeDefined()
        expect(ce).toBeDefined()
        expect(ce).not.toHaveProperty("target")
        expect(ce).not.toHaveProperty("tool")
      })
    })

    it("--tool exempts code_exec (never matches — it has no tool field)", async () => {
      await withTempHome(async (home) => {
        const env = { ...process.env, JUNCTION_HOME: home }
        const toolCall = makeEntry({
          target: { profile: "work", namespace: "github", tool: "search" },
        })
        const codeExec = makeCodeExecEntry()
        await seedAuditLog(home, [toolCall, codeExec])

        const result = await run(env, ["audit", "--tool", "search", "--json"])
        const rows = JSON.parse(result.stdout.trim()) as AuditEntry[]
        expect(rows).toHaveLength(1)
        expect(rows[0]?.event).toBe("tool_call")
      })
    })

    it("--profile still matches a code_exec entry by its own `profile` field", async () => {
      await withTempHome(async (home) => {
        const env = { ...process.env, JUNCTION_HOME: home }
        const workCodeExec = makeCodeExecEntry({ profile: "work" })
        const otherCodeExec = makeCodeExecEntry({
          profile: "other",
          principal: { kind: "stdio", keyId: null, label: null, profiles: ["other"] },
        })
        await seedAuditLog(home, [workCodeExec, otherCodeExec])

        const result = await run(env, ["audit", "--profile", "work", "--json"])
        const rows = JSON.parse(result.stdout.trim()) as AuditEntry[]
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ event: "code_exec", profile: "work" })
      })
    })
  },
)
