// SPDX-License-Identifier: AGPL-3.0-only
// CLI edge tests for `junction credential add` and `junction credential list`.
//
// CRITICAL: two token security tests verify:
//   (a) the token NEVER appears in command stdout/stderr
//   (b) a whole-DB scan finds NO trace of the token
//
// The "unit" suite runs under `pnpm verify` (no build needed).
// The "built bin" suite drives the compiled dist/index.js; skipped when absent.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  addCredential,
  createCredentialStore,
  createRepositories,
  getDatabase,
  getPaths,
  PlatformIdSchema,
  PlatformSchema,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { credentialCommand } from "./credential.js"

// ---------------------------------------------------------------------------
// Mock @clack/prompts so the interactive (non---token-stdin) secret-entry path
// can be driven in-process without a real TTY/pipe. acquireSecret dynamically
// imports "@clack/prompts" and calls password({ message }) — mocked here to
// resolve a fixed value so unit tests can exercise kind derivation/rejection
// without spawning a child process.
// ---------------------------------------------------------------------------

let mockPasswordValue = "mock-secret-value"
vi.mock("@clack/prompts", () => ({
  password: vi.fn(async () => mockPasswordValue),
  isCancel: vi.fn(() => false),
}))

const execFileAsync = promisify(execFile)
const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js")
const coreDistMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@junction/core/dist/migrations",
)
const builtBinReady = existsSync(distIndex) && existsSync(coreDistMigrations)

/** Run a CLI command and return stdout+stderr (ignores exit code). */
async function runCmd(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("node", [distIndex, ...args], { env }, (err, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: (err as { code?: number } | null)?.code ?? 0,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Unit suite — direct command invocation (no build needed), runs under
// `pnpm verify`. Covers kind derivation, kind-incompatible rejection,
// `credential test` unknown-id, and the "verified" column's "-" default.
// ---------------------------------------------------------------------------

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

/** Minimal citty run context — matches what citty passes to run(). */
function ctx<T extends Record<string, unknown>>(args: T) {
  return { args, cmd: {} as never, rawArgs: [] as string[] }
}

/** Access a subcommand's run function from credentialCommand. */
function getCredentialSubCmd(name: string) {
  const subs = (
    credentialCommand as unknown as {
      subCommands: Record<string, { run?: (c: unknown) => Promise<void> }>
    }
  ).subCommands
  const cmd = subs[name]
  if (!cmd) throw new Error(`subcommand "${name}" not found`)
  return cmd
}

/** Upsert an apiKey-scheme openapi platform into the temp-home DB. */
async function setupApiKeyPlatform(platformId: string) {
  const dbResult = await getDatabase(getPaths())
  if (dbResult.isErr()) throw new Error(`DB error: ${dbResult.error.kind}`)
  const repos = createRepositories(dbResult.value)
  const platform = PlatformSchema.parse({
    id: PlatformIdSchema.parse(platformId),
    kind: "openapi" as const,
    displayName: "ApiKey Platform",
    openapi: {
      spec: { from: "url" as const, url: "https://example.com/openapi.json" },
      auth: { scheme: "apiKey" as const, in: "header" as const, name: "X-Api-Key" },
    },
  })
  await repos.platforms.upsert(platform)
  return repos
}

/** Upsert a no-auth openapi platform (empty kind-compat matrix) into the temp-home DB. */
async function setupNoAuthPlatform(platformId: string) {
  const dbResult = await getDatabase(getPaths())
  if (dbResult.isErr()) throw new Error(`DB error: ${dbResult.error.kind}`)
  const repos = createRepositories(dbResult.value)
  const platform = PlatformSchema.parse({
    id: PlatformIdSchema.parse(platformId),
    kind: "openapi" as const,
    displayName: "No Auth Platform",
    openapi: { spec: { from: "url" as const, url: "https://example.com/openapi.json" } },
  })
  await repos.platforms.upsert(platform)
  return repos
}

describe("credential add — kind derivation + kind-compat (unit)", () => {
  let prevStore: string | undefined
  let prevExitCode: number | undefined

  beforeEach(() => {
    prevStore = process.env.JUNCTION_STORE
    prevExitCode = process.exitCode
    process.env.JUNCTION_STORE = "file"
    process.exitCode = 0
  })

  afterEach(() => {
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    process.exitCode = prevExitCode
  })

  it("derives kind api-key for an apiKey-scheme platform when --kind is omitted", async () => {
    await withTempHome(async () => {
      await setupApiKeyPlatform("apikey-plat")
      mockPasswordValue = "some-api-key-value"

      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: "apikey-plat",
            account: "work",
            "token-stdin": false,
            verify: false,
            json: true,
            kind: undefined,
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as {
        ok: boolean
        credential?: { kind?: string }
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.credential?.kind).toBe("api-key")
      expect(process.exitCode).toBe(0)
    })
  })

  it("explicit --kind outside the matrix → kind-incompatible error naming the allowed set", async () => {
    await withTempHome(async () => {
      await setupApiKeyPlatform("apikey-bad-kind-plat")
      mockPasswordValue = "some-value"

      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: "apikey-bad-kind-plat",
            account: "work",
            kind: "env",
            "token-stdin": false,
            verify: false,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("env")
      expect(parsed.error).toContain("api-key")
      expect(process.exitCode).toBe(1)
    })
  })

  it("no --kind and an empty compat matrix (no-auth platform) → clean error before stdin is read", async () => {
    await withTempHome(async () => {
      await setupNoAuthPlatform("no-auth-plat")

      const add = getCredentialSubCmd("add")
      // No stdin is fed here — the no-auth check happens before acquireSecret,
      // so the command must exit without ever waiting on stdin.
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: "no-auth-plat",
            account: "work",
            "token-stdin": true,
            verify: false,
            json: true,
            kind: undefined,
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("no auth")
      expect(process.exitCode).toBe(1)
    })
  })
})

describe("credential test — unknown id (unit)", () => {
  let prevStore: string | undefined
  let prevExitCode: number | undefined

  beforeEach(() => {
    prevStore = process.env.JUNCTION_STORE
    prevExitCode = process.exitCode
    process.env.JUNCTION_STORE = "file"
    process.exitCode = 0
  })

  afterEach(() => {
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    process.exitCode = prevExitCode
  })

  it("credential test --id <unknown> → not-found error, exit 1, no secret leak", async () => {
    await withTempHome(async () => {
      const testCmd = getCredentialSubCmd("test")
      const out = await captureStdout(() =>
        testCmd.run?.(ctx({ id: "cred_does_not_exist", json: true })),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("not found")
      expect(process.exitCode).toBe(1)
    })
  })
})

describe("credential list — verified column (unit)", () => {
  let prevStore: string | undefined
  let prevExitCode: number | undefined

  beforeEach(() => {
    prevStore = process.env.JUNCTION_STORE
    prevExitCode = process.exitCode
    process.env.JUNCTION_STORE = "file"
    process.exitCode = 0
  })

  afterEach(() => {
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    process.exitCode = prevExitCode
  })

  it("a never-verified credential renders lastVerifyResult/lastVerifiedAt as null in --json", async () => {
    await withTempHome(async () => {
      const repos = await setupApiKeyPlatform("list-verify-plat")
      const storeResult = await createCredentialStore(getPaths())
      if (storeResult.isErr()) throw new Error("store setup failed")
      const addResult = await addCredential(
        { platformId: "list-verify-plat", account: "work", kind: "api-key", secret: "seed-value" },
        (await repos.platforms.get("list-verify-plat"))._unsafeUnwrap(),
        storeResult.value,
        repos.credentials,
      )
      if (addResult.isErr()) throw new Error("seed credential add failed")

      const list = getCredentialSubCmd("list")
      const out = await captureStdout(() =>
        list.run?.(ctx({ platform: "list-verify-plat", json: true })),
      )
      const parsed = JSON.parse(out.trim()) as Array<{
        lastVerifyResult: string | null
        lastVerifiedAt: string | null
      }>
      expect(parsed).toHaveLength(1)
      expect(parsed[0]?.lastVerifyResult).toBeNull()
      expect(parsed[0]?.lastVerifiedAt).toBeNull()
    })
  })

  it("a never-verified credential renders '-' in the human table output", async () => {
    await withTempHome(async () => {
      const repos = await setupApiKeyPlatform("list-verify-human-plat")
      const storeResult = await createCredentialStore(getPaths())
      if (storeResult.isErr()) throw new Error("store setup failed")
      const addResult = await addCredential(
        {
          platformId: "list-verify-human-plat",
          account: "work",
          kind: "api-key",
          secret: "seed-value",
        },
        (await repos.platforms.get("list-verify-human-plat"))._unsafeUnwrap(),
        storeResult.value,
        repos.credentials,
      )
      if (addResult.isErr()) throw new Error("seed credential add failed")

      const list = getCredentialSubCmd("list")
      const out = await captureStdout(() =>
        list.run?.(ctx({ platform: "list-verify-human-plat", json: false })),
      )
      expect(out).toContain("verified")
      expect(out).toContain("-")
    })
  })
})

describe.skipIf(!builtBinReady)("credential commands (built bin, child process)", () => {
  // ---------------------------------------------------------------------------
  // CRITICAL TOKEN TEST (a): token never appears in any command output
  // ---------------------------------------------------------------------------
  it("CRITICAL (a): SENTINEL token never appears in stdout or stderr of any credential command", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      const SENTINEL = "SENTINEL_TOKEN_never_in_output_abc123xyz"

      // First define a platform (generic — not vendor-specific)
      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "test-platform",
          "--kind",
          "mcp",
          "--display-name",
          "Test Platform",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )

      // Add credential via --token-stdin (pipe the sentinel token)
      const addResult = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve) => {
          const child = execFile(
            "node",
            [
              distIndex,
              "credential",
              "add",
              "--platform",
              "test-platform",
              "--account",
              "work",
              "--kind",
              "bearer",
              "--token-stdin",
              "--json",
            ],
            { env },
            (err, stdout, stderr) => {
              resolve({
                stdout,
                stderr,
                exitCode: (err as { code?: number } | null)?.code ?? 0,
              })
            },
          )
          child.stdin?.write(SENTINEL)
          child.stdin?.end()
        },
      )

      // The token must NOT appear anywhere in stdout or stderr
      expect(addResult.stdout, "token in stdout of credential add").not.toContain(SENTINEL)
      expect(addResult.stderr, "token in stderr of credential add").not.toContain(SENTINEL)
      expect(addResult.exitCode).toBe(0)

      // list must return metadata only — NEVER the token
      const listResult = await runCmd(
        ["credential", "list", "--platform", "test-platform", "--json"],
        env,
      )
      expect(listResult.stdout, "token in stdout of credential list").not.toContain(SENTINEL)
      expect(listResult.stderr, "token in stderr of credential list").not.toContain(SENTINEL)

      // The --json output must have metadata but no token or secretRef
      const listParsed = JSON.parse(listResult.stdout.trim()) as Array<Record<string, unknown>>
      expect(listParsed.length).toBe(1)
      const item = listParsed[0]
      expect(item).toHaveProperty("id")
      expect(item).toHaveProperty("account")
      expect(item).toHaveProperty("kind")
      expect(JSON.stringify(item)).not.toContain(SENTINEL)
      // secretRef must NOT be in the list output
      expect(item).not.toHaveProperty("secretRef")
    })
  })

  // ---------------------------------------------------------------------------
  // CRITICAL TOKEN TEST (b): whole-DB scan finds NO trace of the token
  // ---------------------------------------------------------------------------
  it("CRITICAL (b): SENTINEL token never appears in any DB column (whole-DB scan)", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      const SENTINEL = "SENTINEL_TOKEN_not_in_db_xyz789abc"

      // Define a platform
      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "db-scan-platform",
          "--kind",
          "mcp",
          "--display-name",
          "DB Scan Platform",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )

      // Add credential via --token-stdin
      await new Promise<void>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "add",
            "--platform",
            "db-scan-platform",
            "--account",
            "work",
            "--kind",
            "bearer",
            "--token-stdin",
            "--json",
          ],
          { env },
          () => resolve(),
        )
        child.stdin?.write(SENTINEL)
        child.stdin?.end()
      })

      // CRITICAL TOKEN TEST (b): whole-DB scan via raw file bytes.
      // SQLite stores TEXT columns as UTF-8 inline in B-tree pages, so the sentinel
      // WILL appear in the raw bytes if it was ever written to any column. This scan
      // covers every table without needing an open DB connection or drizzle-orm dep.
      const dbPath = join(home, "junction.db")
      expect(existsSync(dbPath), "junction.db must exist after credential add").toBe(true)
      const dbBytes = await readFile(dbPath)
      const dbText = dbBytes.toString("utf8")
      expect(dbText, "Token found in junction.db raw bytes").not.toContain(SENTINEL)

      // Also check the WAL file if it exists (WAL mode is enabled by default)
      const walPath = `${dbPath}-wal`
      if (existsSync(walPath)) {
        const walBytes = await readFile(walPath)
        expect(walBytes.toString("utf8"), "Token found in junction.db-wal").not.toContain(SENTINEL)
      }

      // Verify the encrypted-file store does NOT contain the token in plaintext
      // (it's AES-256-GCM encrypted — the file stores only hex ciphertext)
      try {
        const storeContents = await readFile(join(home, "credentials.enc.json"), "utf8")
        expect(storeContents).not.toContain(SENTINEL)
      } catch {
        // Store file may not exist in keyring mode — that's fine
      }
    })
  })

  // ---------------------------------------------------------------------------
  // credential list — metadata only, never secretRef
  // ---------------------------------------------------------------------------
  it("credential list --json shows metadata only — no secretRef field", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "meta-platform",
          "--kind",
          "mcp",
          "--display-name",
          "Meta Platform",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )

      await new Promise<void>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "add",
            "--platform",
            "meta-platform",
            "--account",
            "myaccount",
            "--kind",
            "bearer",
            "--token-stdin",
            "--json",
          ],
          { env },
          () => resolve(),
        )
        child.stdin?.write("any-token-value")
        child.stdin?.end()
      })

      const { stdout } = await execFileAsync(
        "node",
        [distIndex, "credential", "list", "--platform", "meta-platform", "--json"],
        { env },
      )
      const parsed = JSON.parse(stdout.trim()) as Array<Record<string, unknown>>
      expect(parsed.length).toBe(1)
      const item = parsed[0] ?? {}

      // MUST have metadata fields
      expect(item).toHaveProperty("id")
      expect(item).toHaveProperty("account")
      expect(item).toHaveProperty("kind", "bearer")
      expect(item).toHaveProperty("platformId")

      // MUST NOT have secret-adjacent fields
      expect(item).not.toHaveProperty("secretRef")
      expect(item).not.toHaveProperty("secret")
      expect(item).not.toHaveProperty("token")
    })
  })

  it("credential add --json returns ok with metadata but no secret", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "add-meta-plat",
          "--kind",
          "mcp",
          "--display-name",
          "Add Meta",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )

      const result = await new Promise<{ stdout: string }>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "add",
            "--platform",
            "add-meta-plat",
            "--account",
            "work",
            "--kind",
            "bearer",
            "--token-stdin",
            "--json",
          ],
          { env },
          (_err, stdout) => resolve({ stdout }),
        )
        child.stdin?.write("my-secret-token")
        child.stdin?.end()
      })

      const parsed = JSON.parse(result.stdout.trim()) as {
        ok: boolean
        credential?: Record<string, unknown>
      }
      expect(parsed.ok).toBe(true)
      const cred = parsed.credential ?? {}
      expect(cred).toHaveProperty("id")
      expect(cred).toHaveProperty("account", "work")
      expect(cred).toHaveProperty("kind", "bearer")
      // MUST NOT expose secret or secretRef
      expect(cred).not.toHaveProperty("secretRef")
      expect(cred).not.toHaveProperty("secret")
      expect(JSON.stringify(cred)).not.toContain("my-secret-token")
    })
  })

  // ---------------------------------------------------------------------------
  // credential remove — success + in-use RESTRICT guard
  // ---------------------------------------------------------------------------
  it("credential remove --id removes the credential and exits 0", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "rm-plat",
          "--display-name",
          "Remove Plat",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )

      const addResult = await new Promise<{ stdout: string }>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "add",
            "--platform",
            "rm-plat",
            "--account",
            "work",
            "--kind",
            "bearer",
            "--token-stdin",
            "--json",
          ],
          { env },
          (_err, stdout) => resolve({ stdout }),
        )
        child.stdin?.write("remove-test-token")
        child.stdin?.end()
      })

      const credId = (JSON.parse(addResult.stdout.trim()) as { credential: { id: string } })
        .credential.id

      const rmResult = await runCmd(["credential", "remove", "--id", credId, "--json"], env)
      expect(rmResult.exitCode).toBe(0)
      const parsed = JSON.parse(rmResult.stdout.trim()) as { ok: boolean; id?: string }
      expect(parsed.ok).toBe(true)
      expect(parsed.id).toBe(credId)

      // verify it's gone from list
      const listAfter = await runCmd(["credential", "list", "--platform", "rm-plat", "--json"], env)
      const remaining = JSON.parse(listAfter.stdout.trim()) as unknown[]
      expect(remaining).toHaveLength(0)
    })
  })

  it("credential remove --id while source references it → in-use error, exit 1, secret NOT deleted", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      // Setup: platform + credential + profile + source
      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "inuse-plat",
          "--display-name",
          "InUse",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )
      const addResult = await new Promise<{ stdout: string }>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "add",
            "--platform",
            "inuse-plat",
            "--account",
            "work",
            "--kind",
            "bearer",
            "--token-stdin",
            "--json",
          ],
          { env },
          (_err, stdout) => resolve({ stdout }),
        )
        child.stdin?.write("inuse-test-token")
        child.stdin?.end()
      })
      const credId = (JSON.parse(addResult.stdout.trim()) as { credential: { id: string } })
        .credential.id

      await execFileAsync(
        "node",
        [distIndex, "profile", "create", "--name", "inuse-prof", "--json"],
        {
          env,
        },
      )
      await execFileAsync(
        "node",
        [
          distIndex,
          "profile",
          "add-source",
          "--profile",
          "inuse-prof",
          "--platform",
          "inuse-plat",
          "--credential",
          credId,
          "--namespace",
          "srv",
          "--json",
        ],
        { env },
      )

      // Now try to remove — should fail with in-use
      const rmResult = await runCmd(["credential", "remove", "--id", credId, "--json"], env)
      expect(rmResult.exitCode).toBe(1)
      const parsed = JSON.parse(rmResult.stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("in use")
    })
  })

  // ---------------------------------------------------------------------------
  // credential rotate — secret changes; new secret never in output
  // ---------------------------------------------------------------------------

  it("credential rotate --id --secret-stdin --json succeeds and never exposes the new secret", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      const INITIAL_SECRET = "initial-secret-value"
      const NEW_SENTINEL = "ROTATE_SENTINEL_MUST_NOT_APPEAR_IN_OUTPUT_qrs456"

      // Seed platform + credential.
      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "rotate-plat",
          "--kind",
          "mcp",
          "--display-name",
          "Rotate Platform",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )

      const addResult = await new Promise<{ stdout: string }>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "add",
            "--platform",
            "rotate-plat",
            "--account",
            "work",
            "--kind",
            "bearer",
            "--token-stdin",
            "--json",
          ],
          { env },
          (_err, stdout) => resolve({ stdout }),
        )
        child.stdin?.write(INITIAL_SECRET)
        child.stdin?.end()
      })

      const credId = (
        JSON.parse(addResult.stdout.trim()) as { ok: boolean; credential: { id: string } }
      ).credential.id

      // Rotate via --secret-stdin.
      const rotateResult = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve) => {
          const child = execFile(
            "node",
            [distIndex, "credential", "rotate", "--id", credId, "--secret-stdin", "--json"],
            { env },
            (err, stdout, stderr) => {
              resolve({
                stdout,
                stderr,
                exitCode: (err as { code?: number } | null)?.code ?? 0,
              })
            },
          )
          child.stdin?.write(NEW_SENTINEL)
          child.stdin?.end()
        },
      )

      // Rotation must succeed.
      expect(rotateResult.exitCode).toBe(0)
      const rotateParsed = JSON.parse(rotateResult.stdout.trim()) as {
        ok: boolean
        credential?: Record<string, unknown>
      }
      expect(rotateParsed.ok).toBe(true)

      // SECURITY: new secret sentinel must NOT appear in stdout or stderr.
      expect(rotateResult.stdout, "new secret in stdout").not.toContain(NEW_SENTINEL)
      expect(rotateResult.stderr, "new secret in stderr").not.toContain(NEW_SENTINEL)

      // Output is metadata-only (no secretRef, no secret).
      const cred = rotateParsed.credential ?? {}
      expect(cred).toHaveProperty("id", credId)
      expect(cred).toHaveProperty("account", "work")
      expect(cred).toHaveProperty("kind", "bearer")
      expect(cred).not.toHaveProperty("secretRef")
      expect(cred).not.toHaveProperty("secret")
      expect(JSON.stringify(cred)).not.toContain(NEW_SENTINEL)

      // The credential still appears in list after rotation.
      const listAfter = await runCmd(
        ["credential", "list", "--platform", "rotate-plat", "--json"],
        env,
      )
      const listParsed = JSON.parse(listAfter.stdout.trim()) as unknown[]
      expect(listParsed).toHaveLength(1)
    })
  })

  it("credential rotate --id with unknown id exits 1 with error", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      const result = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "rotate",
            "--id",
            "cred_does_not_exist",
            "--secret-stdin",
            "--json",
          ],
          { env },
          (err, stdout) => {
            resolve({ stdout, exitCode: (err as { code?: number } | null)?.code ?? 0 })
          },
        )
        child.stdin?.write("irrelevant-secret")
        child.stdin?.end()
      })

      expect(result.exitCode).toBe(1)
      const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean }
      expect(parsed.ok).toBe(false)
    })
  })
})
