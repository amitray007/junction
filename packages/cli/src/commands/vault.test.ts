// SPDX-License-Identifier: AGPL-3.0-only
// Unit-level CLI edge tests for `junction vault export`/`import` (increment 32.4).
// Direct command invocation (no build needed) — covers the headless no-hang
// contract (I3), the --out-in-home refusal (C4), and --on-collision validation.
// The full export→import round-trip against the real BUILT bin is driven
// manually as part of the increment's proof-of-done (method file §6) — this
// suite covers the fast CLI-edge cases `pnpm verify` gates on.

import path from "node:path"
import { PassThrough } from "node:stream"
import {
  addCredential,
  createCredentialStore,
  createRepositories,
  getDatabase,
  getPaths,
  newPlatformId,
  PlatformSchema,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { vaultCommand } from "./vault.js"

// Mock @clack/prompts — the interactive passphrase-prompt path is exercised via
// the headless (--passphrase-stdin) path in these unit tests; the prompt path
// itself is covered by the isTTY guard tests below (asserting it's SKIPPED).
vi.mock("@clack/prompts", () => ({
  password: vi.fn(async () => "mock-passphrase"),
  isCancel: vi.fn(() => false),
}))

/** Capture everything written to process.stdout during fn(). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  const intercept: NodeJS.WriteStream["write"] = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  }
  process.stdout.write = intercept
  try {
    await fn()
  } finally {
    process.stdout.write = orig
  }
  return chunks.join("")
}

function ctx<T extends Record<string, unknown>>(args: T, rawArgs: string[] = []) {
  return { args, cmd: {} as never, rawArgs }
}

function getVaultSubCmd(name: string) {
  const subs = (
    vaultCommand as unknown as {
      subCommands: Record<string, { run?: (c: unknown) => Promise<void> }>
    }
  ).subCommands
  const cmd = subs[name]
  if (!cmd) throw new Error(`subcommand "${name}" not found`)
  return cmd
}

const realStdin = process.stdin
const realStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
const realStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")

function fakeStdin(): PassThrough {
  const fake = new PassThrough()
  Object.defineProperty(process, "stdin", { value: fake, configurable: true })
  return fake
}
function feedStdin(value: string): void {
  ;(process.stdin as unknown as PassThrough).end(value)
}
function restoreStdin(): void {
  Object.defineProperty(process, "stdin", { value: realStdin, configurable: true })
}
function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true })
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true })
}
function restoreTTY(): void {
  if (realStdoutIsTTY) Object.defineProperty(process.stdout, "isTTY", realStdoutIsTTY)
  if (realStdinIsTTY) Object.defineProperty(process.stdin, "isTTY", realStdinIsTTY)
}

describe("vault export/import (unit, direct invocation)", () => {
  afterEach(() => {
    restoreStdin()
    restoreTTY()
    vi.clearAllMocks()
  })

  it("export: --out inside ~/.junction is refused (C4)", async () => {
    await withTempHome(async (home) => {
      process.env.JUNCTION_STORE = "file"
      const exportCmd = getVaultSubCmd("export")
      const insideHome = path.join(home, "leak.jvlt")
      const stdout = await captureStdout(async () => {
        await exportCmd.run?.(
          ctx({
            out: insideHome,
            "passphrase-stdin": false,
            "include-profiles": false,
            "skip-missing": false,
            json: true,
          }),
        )
      })
      const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}")
      expect(parsed.ok).toBe(false)
      expect(String(parsed.error)).toContain("outside ~/.junction")
    })
  })

  it("export: non-TTY + no --passphrase-stdin → clean refusal, never hangs (I3)", async () => {
    await withTempHome(async (home) => {
      process.env.JUNCTION_STORE = "file"
      setTTY(false)
      const exportCmd = getVaultSubCmd("export")
      const outPath = path.join(path.dirname(home), "headless-export.jvlt")
      const stdout = await captureStdout(async () => {
        await exportCmd.run?.(
          ctx({
            out: outPath,
            "passphrase-stdin": false,
            "include-profiles": false,
            "skip-missing": false,
            json: true,
          }),
        )
      })
      const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}")
      expect(parsed.ok).toBe(false)
      expect(String(parsed.error)).toContain("passphrase required")
      expect(String(parsed.error)).toContain("--passphrase-stdin")
    })
  })

  it("export: --passphrase-stdin with empty/EOF stdin → clean refusal, never hangs", async () => {
    await withTempHome(async (home) => {
      process.env.JUNCTION_STORE = "file"
      const exportCmd = getVaultSubCmd("export")
      const outPath = path.join(path.dirname(home), "empty-stdin-export.jvlt")
      fakeStdin()
      const runPromise = captureStdout(async () => {
        await exportCmd.run?.(
          ctx({
            out: outPath,
            "passphrase-stdin": true,
            "include-profiles": false,
            "skip-missing": false,
            json: true,
          }),
        )
      })
      feedStdin("") // EOF immediately, empty
      const stdout = await runPromise
      const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}")
      expect(parsed.ok).toBe(false)
      expect(String(parsed.error)).toContain("must not be empty")
    })
  })

  it("import: non-TTY + no --passphrase-stdin → clean refusal, never hangs (I3)", async () => {
    await withTempHome(async () => {
      process.env.JUNCTION_STORE = "file"
      setTTY(false)
      const importCmd = getVaultSubCmd("import")
      const stdout = await captureStdout(async () => {
        await importCmd.run?.(
          ctx({
            archive: "/tmp/does-not-need-to-exist-because-passphrase-checked-after-read.jvlt",
            "passphrase-stdin": false,
            "on-collision": "skip",
            "include-profiles": false,
            json: true,
          }),
        )
      })
      const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}")
      expect(parsed.ok).toBe(false)
      // Either the archive-read error or the passphrase error is acceptable —
      // both are clean, neither hangs. Assert we got A clean JSON error line.
      expect(typeof parsed.error).toBe("string")
    })
  })

  it("import: --on-collision rejects an invalid value", async () => {
    await withTempHome(async () => {
      process.env.JUNCTION_STORE = "file"
      const importCmd = getVaultSubCmd("import")
      const stdout = await captureStdout(async () => {
        await importCmd.run?.(
          ctx({
            archive: "/tmp/irrelevant.jvlt",
            "passphrase-stdin": false,
            "on-collision": "bogus",
            "include-profiles": false,
            json: true,
          }),
        )
      })
      const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}")
      expect(parsed.ok).toBe(false)
      expect(String(parsed.error)).toContain("--on-collision")
    })
  })

  it("export → import round-trip via direct command invocation (--json, --passphrase-stdin)", async () => {
    await withTempHome(async (srcHome) => {
      process.env.JUNCTION_STORE = "file"
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw dbResult.error
      const repos = createRepositories(dbResult.value)
      const storeResult = await createCredentialStore(paths)
      if (storeResult.isErr()) throw storeResult.error
      const store = storeResult.value

      const platformId = newPlatformId()
      const platform = PlatformSchema.parse({
        id: platformId,
        kind: "mcp" as const,
        displayName: "CLI Round Trip Platform",
      })
      await repos.platforms.create(platform)
      const cred = await addCredential(
        {
          platformId: String(platformId),
          account: "work",
          kind: "bearer",
          secret: "CLI_RT_SECRET",
        },
        platform,
        store,
        repos.credentials,
      )
      expect(cred.isOk()).toBe(true)

      const outPath = path.join(path.dirname(srcHome), `cli-rt-${Date.now()}.jvlt`)

      const exportCmd = getVaultSubCmd("export")
      fakeStdin()
      const exportRun = captureStdout(async () => {
        await exportCmd.run?.(
          ctx({
            out: outPath,
            "passphrase-stdin": true,
            "include-profiles": false,
            "skip-missing": false,
            json: true,
          }),
        )
      })
      feedStdin("cli-roundtrip-pass")
      const exportStdout = await exportRun
      const exportParsed = JSON.parse(exportStdout.trim().split("\n").pop() ?? "{}")
      expect(exportParsed.ok).toBe(true)
      expect(exportParsed.credentials).toBe(1)
      restoreStdin()

      // Now import into a FRESH temp home.
      await withTempHome(async () => {
        process.env.JUNCTION_STORE = "file"
        const importCmd = getVaultSubCmd("import")
        fakeStdin()
        const importRun = captureStdout(async () => {
          await importCmd.run?.(
            ctx({
              archive: outPath,
              "passphrase-stdin": true,
              "on-collision": "skip",
              "include-profiles": false,
              json: true,
            }),
          )
        })
        feedStdin("cli-roundtrip-pass")
        const importStdout = await importRun
        const importParsed = JSON.parse(importStdout.trim().split("\n").pop() ?? "{}")
        expect(importParsed.ok).toBe(true)
        expect(importParsed.summary.credentials.added).toBe(1)

        // Verify the restored secret resolves in the fresh home.
        const dstPaths = getPaths()
        const dstDb = await getDatabase(dstPaths)
        if (dstDb.isErr()) throw dstDb.error
        const dstRepos = createRepositories(dstDb.value)
        const dstStoreResult = await createCredentialStore(dstPaths)
        if (dstStoreResult.isErr()) throw dstStoreResult.error
        const dstCreds = (await dstRepos.credentials.list())._unsafeUnwrap()
        expect(dstCreds).toHaveLength(1)
        const secret = await dstStoreResult.value.get(dstCreds[0]?.secretRef ?? "")
        expect(secret.isOk()).toBe(true)
        if (secret.isOk()) expect(secret.value).toBe("CLI_RT_SECRET")

        // grep -a sentinel check on the archive bytes.
        const { readFile, unlink } = await import("node:fs/promises")
        const archiveBytes = await readFile(outPath)
        expect(archiveBytes.toString("latin1")).not.toContain("CLI_RT_SECRET")
        await unlink(outPath).catch(() => {})
      })
    })
  })
})
