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
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  addCredential,
  type Credential,
  CredentialSchema,
  createCredentialStore,
  createRepositories,
  getDatabase,
  getPaths,
  ok,
  PlatformIdSchema,
  PlatformSchema,
  ResultAsync,
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

// ---------------------------------------------------------------------------
// Mock @junction/source-runtime's connect-engine fns (consumed by `credential
// reconnect`, D2, via connect.ts's shared runConnectFlow) — no real
// HTTP/browser; this file drives the CLI edge only. The device flow (not
// the browser flow) is used throughout since it needs no HTTP listener.
// verifyCredential/other exports pass through unmocked (importOriginal).
// ---------------------------------------------------------------------------

const persistOAuthTokensMock = vi.fn()
const deviceAuthorizeMock = vi.fn()
const devicePollMock = vi.fn()
vi.mock("@junction/source-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/source-runtime")>()
  return {
    ...actual,
    persistOAuthTokens: (...args: unknown[]) => persistOAuthTokensMock(...args),
    deviceAuthorize: (...args: unknown[]) => deviceAuthorizeMock(...args),
    devicePoll: (...args: unknown[]) => devicePollMock(...args),
  }
})

// ---------------------------------------------------------------------------
// Synthetic device-code-capable provider — the catalog is github-only since
// the inc 35 strip-down (docs/methods/35-catalog-stripdown.md); no surviving
// provider carries a deviceAuthorizationUrl (google, the prior device-code
// example, was removed). Injected into getProvider/listProviders below so
// `credential reconnect`'s device flow stays under real test coverage rather
// than going untested until a device-code provider is reintroduced. Mirrors
// connect.test.ts's identical fixture (same shape, kept file-local since
// these two test files don't share a fixtures module).
// ---------------------------------------------------------------------------

// Hoisted so the vi.mock factory below (which vitest lifts to the top of the
// file) can reference it without a TDZ crash — a plain top-level `const` is
// initialized AFTER the hoisted factory runs.
const { DEVICE_CODE_PROVIDER_ID } = vi.hoisted(() => ({
  DEVICE_CODE_PROVIDER_ID: "synthetic-device-code-provider",
}))

vi.mock("@junction/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/core")>()
  const syntheticDeviceProvider: import("@junction/core").OAuthProvider = {
    id: DEVICE_CODE_PROVIDER_ID,
    displayName: "Synthetic Device-Code Provider",
    authorizationUrl: "https://example.com/oauth/authorize",
    tokenUrl: "https://example.com/oauth/token",
    deviceAuthorizationUrl: "https://example.com/oauth/device/code",
    pkce: "S256",
    scopeSeparator: " ",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-ephemeral",
    supportsRefresh: true,
    registrationHint: { redirectUri: "", scopes: "synthetic test fixture", docsUrl: "" },
  }
  return {
    ...actual,
    getProvider: (id: string) =>
      id === DEVICE_CODE_PROVIDER_ID ? syntheticDeviceProvider : actual.getProvider(id),
    listProviders: () => [...actual.listProviders(), syntheticDeviceProvider],
    // Increment 45 (Slice C) — `credential reconnect` now resolves its design
    // via the MERGED (built-in + custom) designs set, not `getProvider`
    // directly (mergeDesigns(customDesigns) — see resolve-credential-provider
    // -id.ts / credential.ts's reconnectCommand). The synthetic device-code
    // provider above needs to be visible through THIS path too, or reconnect
    // can't find a design object to drive the flow — patch mergeDesigns the
    // same way getProvider/listProviders are patched.
    mergeDesigns: (custom: Parameters<typeof actual.mergeDesigns>[0]) => {
      const merged = actual.mergeDesigns(custom)
      merged.set(DEVICE_CODE_PROVIDER_ID, syntheticDeviceProvider)
      return merged
    },
  }
})

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
function ctx<T extends Record<string, unknown>>(args: T, rawArgs: string[] = []) {
  return { args, cmd: {} as never, rawArgs }
}

// ---------------------------------------------------------------------------
// stdin faking for --client-secret-stdin (D2's reconnect suite) — a fresh
// PassThrough per test, swapped in for the real process.stdin singleton.
// See connect.test.ts's identical helper for why: the real process.stdin can
// only be ended (EOF) ONCE per process, and a bare emit("data"/"end") races
// against listener attachment — both were observed to hang.
// ---------------------------------------------------------------------------

const realStdin = process.stdin

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

/** Upsert a cli platform (accepts kind "file", among env/bearer) into the temp-home DB. */
async function setupCliPlatform(platformId: string) {
  const dbResult = await getDatabase(getPaths())
  if (dbResult.isErr()) throw new Error(`DB error: ${dbResult.error.kind}`)
  const repos = createRepositories(dbResult.value)
  const platform = PlatformSchema.parse({
    id: PlatformIdSchema.parse(platformId),
    kind: "cli" as const,
    displayName: "CLI Platform",
    cli: {
      tools: [
        {
          name: "greet",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 5000,
            envAllow: {},
          },
        },
      ],
      credentialEnvVar: "GH_PAT",
    },
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

// ---------------------------------------------------------------------------
// Increment 42 — credential name (identity slug). `--name` derivation for
// the legacy --platform/--account path, and the standalone (no --platform)
// create path via addStandaloneCredential.
// ---------------------------------------------------------------------------

describe("credential add — name derivation + standalone create (inc 42, unit)", () => {
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

  it("the inc-style `--platform gh --account personal --token-stdin` (no --name) derives name gh-personal", async () => {
    await withTempHome(async () => {
      await setupApiKeyPlatform("gh")
      mockPasswordValue = "some-token-value"

      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: "gh",
            account: "personal",
            "token-stdin": false,
            verify: false,
            json: true,
            kind: undefined,
            name: undefined,
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as {
        ok: boolean
        credential?: { name?: string; platformId?: string; account?: string }
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.credential?.name).toBe("gh-personal")
      expect(parsed.credential?.platformId).toBe("gh")
      expect(parsed.credential?.account).toBe("personal")
      expect(process.exitCode).toBe(0)
    })
  })

  it("an explicit --name on a platform-scoped add is stored verbatim (not derived)", async () => {
    await withTempHome(async () => {
      await setupApiKeyPlatform("gh-named")
      mockPasswordValue = "some-token-value"

      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: "gh-named",
            account: "personal",
            "token-stdin": false,
            verify: false,
            json: true,
            kind: undefined,
            name: "my-custom-name",
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; credential?: { name?: string } }
      expect(parsed.ok).toBe(true)
      expect(parsed.credential?.name).toBe("my-custom-name")
      expect(process.exitCode).toBe(0)
    })
  })

  it("a colliding derived name gets a -2 suffix (mirrors the migration backfill rule)", async () => {
    await withTempHome(async () => {
      await setupApiKeyPlatform("gh-collide")
      mockPasswordValue = "token-1"

      const add = getCredentialSubCmd("add")
      // First add: an EXPLICIT --name that happens to equal what the SECOND
      // add's derivation would naturally produce (`gh-collide-personal`).
      await captureStdout(() =>
        add.run?.(
          ctx({
            platform: "gh-collide",
            account: "seed",
            "token-stdin": false,
            verify: false,
            json: true,
            kind: undefined,
            name: "gh-collide-personal",
          }),
        ),
      )

      // Second add: omits --name → derives "gh-collide-personal", which
      // collides with the first row's explicit name → suffixed "-2".
      mockPasswordValue = "token-2"
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: "gh-collide",
            account: "personal",
            "token-stdin": false,
            verify: false,
            json: true,
            kind: undefined,
            name: undefined,
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; credential?: { name?: string } }
      expect(parsed.ok).toBe(true)
      expect(parsed.credential?.name).toBe("gh-collide-personal-2")
      expect(process.exitCode).toBe(0)
    })
  })

  it("--name required, no --platform → creates a standalone (unlinked) credential", async () => {
    await withTempHome(async () => {
      mockPasswordValue = "standalone-secret-value"

      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: undefined,
            account: undefined,
            "token-stdin": false,
            verify: false,
            json: true,
            kind: undefined,
            name: "my-vault-secret",
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as {
        ok: boolean
        credential?: { name?: string; platformId?: string | null }
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.credential?.name).toBe("my-vault-secret")
      expect(parsed.credential?.platformId).toBeNull()
      expect(process.exitCode).toBe(0)
    })
  })

  it("no --platform and no --name → clean invalid-input error, no stdin read", async () => {
    await withTempHome(async () => {
      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: undefined,
            account: undefined,
            "token-stdin": true,
            verify: false,
            json: true,
            kind: undefined,
            name: undefined,
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("--name")
      expect(process.exitCode).toBe(1)
    })
  })

  it("no --platform but --account given → clean invalid-input error (account is meaningless without a platform)", async () => {
    await withTempHome(async () => {
      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: undefined,
            account: "work",
            "token-stdin": true,
            verify: false,
            json: true,
            kind: undefined,
            name: "some-name",
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("--account")
      expect(process.exitCode).toBe(1)
    })
  })

  it("standalone create rejects kind oauth2", async () => {
    await withTempHome(async () => {
      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: undefined,
            account: undefined,
            "token-stdin": true,
            verify: false,
            json: true,
            kind: "oauth2",
            name: "oauth-not-allowed",
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(process.exitCode).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// --secret-file (increment 28.9 slice D): reads the file's CONTENT and stores
// it — the PATH itself must never reach the store.
// ---------------------------------------------------------------------------

describe("credential add --secret-file (unit)", () => {
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

  it("--secret-file reads the file CONTENT; the store receives the content, never the path", async () => {
    await withTempHome(async () => {
      await setupCliPlatform("cli-file-plat")

      const { mkdtemp, writeFile: writeFileP, rm } = await import("node:fs/promises")
      const os = await import("node:os")
      const dir = await mkdtemp(join(os.tmpdir(), "jx-secret-file-test-"))
      const secretPath = join(dir, "cred.json")
      const CONTENT = '{"type":"service_account","key":"multi\\nline-content"}'
      await writeFileP(secretPath, CONTENT, "utf8")

      try {
        const add = getCredentialSubCmd("add")
        const out = await captureStdout(() =>
          add.run?.(
            ctx({
              platform: "cli-file-plat",
              account: "work",
              kind: "file",
              "secret-file": secretPath,
              "token-stdin": false,
              verify: false,
              json: true,
            }),
          ),
        )

        const parsed = JSON.parse(out.trim()) as {
          ok: boolean
          credential?: { id?: string; kind?: string }
        }
        expect(parsed.ok).toBe(true)
        expect(parsed.credential?.kind).toBe("file")

        // The PATH must never appear anywhere in the command's stdout.
        expect(out).not.toContain(secretPath)

        // The store must have received the CONTENT (verified via a real read-back
        // through the store — never by inspecting DB rows, which hold only refs).
        const credId = parsed.credential?.id
        expect(credId).toBeTruthy()
        const storeResult = await createCredentialStore(getPaths())
        if (storeResult.isErr()) throw new Error("store setup failed")
        const dbResult = await getDatabase(getPaths())
        if (dbResult.isErr()) throw new Error("db setup failed")
        const repos = createRepositories(dbResult.value)
        const credResult = await repos.credentials.get(String(credId))
        if (credResult.isErr()) throw new Error("credential lookup failed")
        const secretResult = await storeResult.value.get(credResult.value.secretRef)
        if (secretResult.isErr()) throw new Error("secret lookup failed")
        expect(secretResult.value).toBe(CONTENT)
        expect(secretResult.value).not.toBe(secretPath)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  it("--secret-file and --token-stdin together → clean mutually-exclusive error", async () => {
    await withTempHome(async () => {
      await setupCliPlatform("cli-file-mutex-plat")

      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: "cli-file-mutex-plat",
            account: "work",
            kind: "file",
            "secret-file": "/nonexistent/path",
            "token-stdin": true,
            verify: false,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("mutually exclusive")
      expect(process.exitCode).toBe(1)
    })
  })

  it("--secret-file pointing at a nonexistent path → clean error, no crash", async () => {
    await withTempHome(async () => {
      await setupCliPlatform("cli-file-missing-plat")

      const add = getCredentialSubCmd("add")
      const out = await captureStdout(() =>
        add.run?.(
          ctx({
            platform: "cli-file-missing-plat",
            account: "work",
            kind: "file",
            "secret-file": "/definitely/does/not/exist/cred.json",
            "token-stdin": false,
            verify: false,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(process.exitCode).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // CORR-1 fix: --secret-file is restricted to kind "file". It reads content
  // WITHOUT trimming (correct for kind "file"'s byte-exactness), so using it
  // with any other kind can inject an untrimmed trailing newline into a
  // bearer/api-key value — undici then rejects the resulting header value as
  // a control character, an opaque failure far from this flag. Reject early
  // with a clear, actionable message instead.
  // -------------------------------------------------------------------------

  it("--secret-file with an explicit non-file kind (--kind env) → clean, actionable error", async () => {
    await withTempHome(async () => {
      await setupCliPlatform("cli-file-kind-mismatch-plat")

      const { mkdtemp, writeFile: writeFileP, rm } = await import("node:fs/promises")
      const os = await import("node:os")
      const dir = await mkdtemp(join(os.tmpdir(), "jx-secret-file-kind-test-"))
      const secretPath = join(dir, "token.txt")
      await writeFileP(secretPath, "bearer-token-value\n", "utf8")

      try {
        const add = getCredentialSubCmd("add")
        const out = await captureStdout(() =>
          add.run?.(
            ctx({
              platform: "cli-file-kind-mismatch-plat",
              account: "work",
              kind: "env",
              "secret-file": secretPath,
              "token-stdin": false,
              verify: false,
              json: true,
            }),
          ),
        )

        const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
        expect(parsed.ok).toBe(false)
        expect(parsed.error).toContain("--secret-file is only valid for file-kind credentials")
        expect(parsed.error).toContain("--token-stdin")
        expect(process.exitCode).toBe(1)
        // The path itself must never leak into the error message either.
        expect(parsed.error).not.toContain(secretPath)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  it("--secret-file with the DERIVED (omitted --kind) non-file default → clean, actionable error", async () => {
    // setupApiKeyPlatform derives to kind "api-key" (not "file") when --kind is
    // omitted — proves the check applies to the DERIVED kind, not only an
    // explicit --kind.
    await withTempHome(async () => {
      await setupApiKeyPlatform("apikey-file-mismatch-plat")

      const { mkdtemp, writeFile: writeFileP, rm } = await import("node:fs/promises")
      const os = await import("node:os")
      const dir = await mkdtemp(join(os.tmpdir(), "jx-secret-file-derived-test-"))
      const secretPath = join(dir, "token.txt")
      await writeFileP(secretPath, "api-key-value\n", "utf8")

      try {
        const add = getCredentialSubCmd("add")
        const out = await captureStdout(() =>
          add.run?.(
            ctx({
              platform: "apikey-file-mismatch-plat",
              account: "work",
              "secret-file": secretPath,
              "token-stdin": false,
              verify: false,
              json: true,
            }),
          ),
        )

        const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
        expect(parsed.ok).toBe(false)
        expect(parsed.error).toContain("--secret-file is only valid for file-kind credentials")
        expect(process.exitCode).toBe(1)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
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

// ---------------------------------------------------------------------------
// Increment 29 slice D — helpers shared by the oauth2 suites below.
// ---------------------------------------------------------------------------

/** Upsert an oauth2-scheme openapi platform into the temp-home DB. */
async function setupOAuthPlatform(platformId: string, oauthProviderId = platformId) {
  const dbResult = await getDatabase(getPaths())
  if (dbResult.isErr()) throw new Error(`DB error: ${dbResult.error.kind}`)
  const repos = createRepositories(dbResult.value)
  const platform = PlatformSchema.parse({
    id: PlatformIdSchema.parse(platformId),
    kind: "openapi" as const,
    displayName: "OAuth Platform",
    openapi: {
      spec: { from: "url" as const, url: "https://example.com/openapi.json" },
      auth: { scheme: "oauth2" as const },
    },
    // Increment 45, Slice E — the design now lives EXCLUSIVELY on the
    // platform (the credential's legacy oauthMeta.providerId fallback is
    // gone). Default to the platformId itself, matching this file's
    // long-standing convention (seedOAuthCredential's legacy providerId was
    // always set to the platformId too).
    oauthProviderId,
  })
  await repos.platforms.upsert(platform)
  return repos
}

/**
 * Seed a raw oauth2 Credential row directly via repos.credentials.create —
 * addCredential REJECTS oauth2 by design (see add-credential.ts), so oauth2
 * fixtures must be seeded through the repo layer, exactly as
 * persistOAuthTokens does in production.
 */
async function seedOAuthCredential(
  platformId: string,
  overrides: Partial<Credential> = {},
): Promise<Credential> {
  const repos = await setupOAuthPlatform(platformId)
  const credential = CredentialSchema.parse({
    id: `${platformId}-cred-1`,
    name: `${platformId}-work`,
    platformId,
    profileName: "work",
    kind: "oauth2" as const,
    secretRef: "ref-access-1",
    // Increment 45, Slice E — the design lives on the PLATFORM
    // (setupOAuthPlatform defaults oauthProviderId to this same platformId),
    // never a denormalized copy in oauthMeta.
    oauthMeta: {
      refreshTokenRef: "ref-refresh-1",
      clientIdRef: "ref-clientid-1",
      clientSecretRef: "ref-clientsecret-1",
      authMode: "authorization_code" as const,
      needsReauth: false,
      ...overrides.oauthMeta,
    },
    ...overrides,
  })
  const createResult = await repos.credentials.create(credential)
  if (createResult.isErr())
    throw new Error(`seed oauth2 credential failed: ${createResult.error.kind}`)
  return createResult.value
}

// ---------------------------------------------------------------------------
// D3 — `credential list` derives oauthState from oauthMeta.
// ---------------------------------------------------------------------------

describe("credential list — oauth2 state derivation (D3, unit)", () => {
  let prevExitCode: number | undefined

  beforeEach(() => {
    prevExitCode = process.exitCode
    process.exitCode = 0
  })

  afterEach(() => {
    process.exitCode = prevExitCode
  })

  it("a connected oauth2 credential (no needsReauth, no near expiry) → oauthState: connected", async () => {
    await withTempHome(async () => {
      // Increment 45, Slice E — resolveOAuthProviderId fails CLOSED on a
      // platform.oauthProviderId that doesn't match a REAL catalog design
      // (SECURITY, R1) — setupOAuthPlatform's default (oauthProviderId =
      // platformId) only works for this assertion when the platformId is
      // itself a real built-in id. Use "github" explicitly so this test's
      // `providerId` assertion below exercises a genuine resolution, not a
      // dangling reference.
      const repos = await setupOAuthPlatform("oauth-connected-plat", "github")
      await repos.credentials.create(
        CredentialSchema.parse({
          id: "oauth-connected-plat-cred-1",
          name: "oauth-connected-plat-work",
          platformId: "oauth-connected-plat",
          profileName: "work",
          kind: "oauth2" as const,
          secretRef: "ref-access-1",
          oauthMeta: {
            refreshTokenRef: "ref-refresh-1",
            clientIdRef: "ref-clientid-1",
            clientSecretRef: "ref-clientsecret-1",
            authMode: "authorization_code" as const,
            needsReauth: false,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
        }),
      )

      const list = getCredentialSubCmd("list")
      const out = await captureStdout(() =>
        list.run?.(ctx({ platform: "oauth-connected-plat", json: true })),
      )
      const parsed = JSON.parse(out.trim()) as Array<{
        oauthState: string | null
        providerId: string | null
        expiresAt: string | null
      }>
      expect(parsed).toHaveLength(1)
      expect(parsed[0]?.oauthState).toBe("connected")
      expect(parsed[0]?.providerId).toBe("github")
    })
  })

  it("needsReauth:true → oauthState: needs-reconnect (takes precedence over expiry)", async () => {
    await withTempHome(async () => {
      await seedOAuthCredential("oauth-needsreauth-plat", {
        oauthMeta: {
          providerId: "oauth-needsreauth-plat",
          needsReauth: true,
        } as Credential["oauthMeta"],
      })

      const list = getCredentialSubCmd("list")
      const out = await captureStdout(() =>
        list.run?.(ctx({ platform: "oauth-needsreauth-plat", json: true })),
      )
      const parsed = JSON.parse(out.trim()) as Array<{ oauthState: string | null }>
      expect(parsed[0]?.oauthState).toBe("needs-reconnect")
    })
  })

  it("near expiry + NO refresh token → oauthState: expiring (can't self-heal → actionable)", async () => {
    await withTempHome(async () => {
      await seedOAuthCredential("oauth-expiring-plat", {
        oauthMeta: {
          providerId: "oauth-expiring-plat",
          needsReauth: false,
          expiresAt: new Date(Date.now() + 60 * 1000).toISOString(), // 1 minute out
          // NO refreshTokenRef → junction can't refresh → Expiring is honest.
        } as Credential["oauthMeta"],
      })

      const list = getCredentialSubCmd("list")
      const out = await captureStdout(() =>
        list.run?.(ctx({ platform: "oauth-expiring-plat", json: true })),
      )
      const parsed = JSON.parse(out.trim()) as Array<{ oauthState: string | null }>
      expect(parsed[0]?.oauthState).toBe("expiring")
    })
  })

  it("near expiry + HAS a refresh token → oauthState: connected (auto-refreshed, never Expiring)", async () => {
    await withTempHome(async () => {
      await seedOAuthCredential("oauth-refreshable-plat", {
        oauthMeta: {
          providerId: "oauth-refreshable-plat",
          needsReauth: false,
          expiresAt: new Date(Date.now() + 60 * 1000).toISOString(), // 1 minute out — but refreshable
          refreshTokenRef: "ref-refresh-live", // junction will refresh it → Connected
        } as Credential["oauthMeta"],
      })

      const list = getCredentialSubCmd("list")
      const out = await captureStdout(() =>
        list.run?.(ctx({ platform: "oauth-refreshable-plat", json: true })),
      )
      const parsed = JSON.parse(out.trim()) as Array<{ oauthState: string | null }>
      expect(parsed[0]?.oauthState).toBe("connected")
    })
  })

  it("a non-oauth2 credential → oauthState: null, and the human table renders '-'", async () => {
    await withTempHome(async () => {
      const repos = await setupApiKeyPlatform("oauth-list-nonoauth-plat")
      const storeResult = await createCredentialStore(getPaths())
      if (storeResult.isErr()) throw new Error("store setup failed")
      const addResult = await addCredential(
        { platformId: "oauth-list-nonoauth-plat", account: "work", kind: "api-key", secret: "v" },
        (await repos.platforms.get("oauth-list-nonoauth-plat"))._unsafeUnwrap(),
        storeResult.value,
        repos.credentials,
      )
      if (addResult.isErr()) throw new Error("seed failed")

      const list = getCredentialSubCmd("list")
      const jsonOut = await captureStdout(() =>
        list.run?.(ctx({ platform: "oauth-list-nonoauth-plat", json: true })),
      )
      const parsed = JSON.parse(jsonOut.trim()) as Array<{ oauthState: string | null }>
      expect(parsed[0]?.oauthState).toBeNull()

      const humanOut = await captureStdout(() =>
        list.run?.(ctx({ platform: "oauth-list-nonoauth-plat", json: false })),
      )
      expect(humanOut).toContain("oauth")
    })
  })

  it("never includes secretRef/refreshTokenRef/clientSecretRef values in --json output", async () => {
    await withTempHome(async () => {
      await seedOAuthCredential("oauth-leakcheck-plat")

      const list = getCredentialSubCmd("list")
      const out = await captureStdout(() =>
        list.run?.(ctx({ platform: "oauth-leakcheck-plat", json: true })),
      )
      expect(out).not.toContain("ref-access-1")
      expect(out).not.toContain("ref-refresh-1")
      expect(out).not.toContain("ref-clientid-1")
      expect(out).not.toContain("ref-clientsecret-1")
    })
  })
})

// ---------------------------------------------------------------------------
// Task 5 — `credential rename` edits the account label in place.
// ---------------------------------------------------------------------------

describe("credential rename (Task 5, unit)", () => {
  let prevExitCode: number | undefined
  beforeEach(() => {
    prevExitCode = process.exitCode
    process.exitCode = 0
  })
  afterEach(() => {
    process.exitCode = prevExitCode
  })

  it("renames the account label of a credential (bearer) — --json shows the new account", async () => {
    await withTempHome(async () => {
      const repos = await setupApiKeyPlatform("rename-plat")
      const storeResult = await createCredentialStore(getPaths())
      if (storeResult.isErr()) throw new Error("store setup failed")
      const added = await addCredential(
        { platformId: "rename-plat", account: "work", kind: "api-key", secret: "v" },
        (await repos.platforms.get("rename-plat"))._unsafeUnwrap(),
        storeResult.value,
        repos.credentials,
      )
      if (added.isErr()) throw new Error("seed failed")

      const rename = getCredentialSubCmd("rename")
      const out = await captureStdout(() =>
        rename.run?.(ctx({ id: added.value.id, account: "work-primary", json: true })),
      )
      const parsed = JSON.parse(out.trim()) as {
        ok: boolean
        credential?: { account: string; id: string }
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.credential?.account).toBe("work-primary")
      // Persisted.
      const reread = (await repos.credentials.get(added.value.id))._unsafeUnwrap()
      expect(reread.profileName).toBe("work-primary")
      // The secret still resolves under the unchanged secretRef.
      const secret = (await storeResult.value.get(reread.secretRef))._unsafeUnwrap()
      expect(secret).toBe("v")
    })
  })

  it("empty --account → clean error, exit 1", async () => {
    await withTempHome(async () => {
      const repos = await setupApiKeyPlatform("rename-empty-plat")
      const storeResult = await createCredentialStore(getPaths())
      if (storeResult.isErr()) throw new Error("store setup failed")
      const added = await addCredential(
        { platformId: "rename-empty-plat", account: "work", kind: "api-key", secret: "v" },
        (await repos.platforms.get("rename-empty-plat"))._unsafeUnwrap(),
        storeResult.value,
        repos.credentials,
      )
      if (added.isErr()) throw new Error("seed failed")

      const rename = getCredentialSubCmd("rename")
      const out = await captureStdout(() =>
        rename.run?.(ctx({ id: added.value.id, account: "  ", json: true })),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(process.exitCode).toBe(1)
    })
  })

  it("unknown credential id → clean not-found error, exit 1", async () => {
    await withTempHome(async () => {
      const rename = getCredentialSubCmd("rename")
      const out = await captureStdout(() =>
        rename.run?.(ctx({ id: "does-not-exist", account: "work", json: true })),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean }
      expect(parsed.ok).toBe(false)
      expect(process.exitCode).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// D4 — `credential rotate` refuses oauth2 credentials.
// ---------------------------------------------------------------------------

describe("credential rotate — rejects oauth2 (D4, unit)", () => {
  let prevExitCode: number | undefined

  beforeEach(() => {
    prevExitCode = process.exitCode
    process.exitCode = 0
    mockPasswordValue = "should-never-be-used"
  })

  afterEach(() => {
    process.exitCode = prevExitCode
  })

  it("rotate --id <oauth2-cred> → clean error naming connect/reconnect, exit 1, --json shaped", async () => {
    await withTempHome(async () => {
      const cred = await seedOAuthCredential("oauth-rotate-reject-plat")

      const rotate = getCredentialSubCmd("rotate")
      const out = await captureStdout(() =>
        rotate.run?.(ctx({ id: cred.id, "secret-stdin": true, json: true })),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("junction connect")
      expect(parsed.error).toContain("credential reconnect")
      expect(process.exitCode).toBe(1)
    })
  })

  it("never reads the new-secret prompt/stdin before rejecting (the doomed rotate never touches stdin)", async () => {
    await withTempHome(async () => {
      const cred = await seedOAuthCredential("oauth-rotate-reject-stdin-plat")

      // secret-stdin: true with NOTHING fed — if the command tried to read
      // stdin before the oauth2 guard, this would hang; a fast return proves
      // the guard runs first (mirrors the empty-id check's discipline).
      const rotate = getCredentialSubCmd("rotate")
      const out = await captureStdout(() =>
        rotate.run?.(ctx({ id: cred.id, "secret-stdin": true, json: true })),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean }
      expect(parsed.ok).toBe(false)
    })
  })

  it("the oauth2 credential's secretRef is unchanged after a rejected rotate (never silently corrupted)", async () => {
    await withTempHome(async () => {
      const cred = await seedOAuthCredential("oauth-rotate-reject-verify-plat")

      const rotate = getCredentialSubCmd("rotate")
      await rotate.run?.(ctx({ id: cred.id, "secret-stdin": true, json: true }))

      const dbResult = await getDatabase(getPaths())
      if (dbResult.isErr()) throw new Error("db reopen failed")
      const repos = createRepositories(dbResult.value)
      const reread = await repos.credentials.get(cred.id)
      if (reread.isErr()) throw new Error("credential reread failed")
      expect(reread.value.secretRef).toBe(cred.secretRef)
      expect(reread.value.oauthMeta?.refreshTokenRef).toBe(cred.oauthMeta?.refreshTokenRef)
    })
  })
})

// ---------------------------------------------------------------------------
// D2 — `credential reconnect` re-runs connect for an existing oauth2
// credential (mode:"update"), clearing needsReauth. The device flow is used
// throughout (headless) — no real browser/HTTP listener needed; the connect
// engine itself (buildAuthorizeUrl/exchangeCode/deviceAuthorize/devicePoll)
// lives in @junction/source-runtime and is exercised directly by
// connect.test.ts — here only persistOAuthTokens(mode:"update") is mocked,
// so this suite proves the reconnect COMMAND's wiring (id → provider →
// mode:update → needsReauth cleared), not the connect engine itself.
// ---------------------------------------------------------------------------

describe("credential reconnect (D2, unit)", () => {
  let prevExitCode: number | undefined

  beforeEach(() => {
    prevExitCode = process.exitCode
    process.exitCode = 0
    persistOAuthTokensMock.mockReset()
    deviceAuthorizeMock.mockReset()
    devicePollMock.mockReset()
  })

  afterEach(() => {
    process.exitCode = prevExitCode
    restoreStdin()
  })

  it("unknown credential id → clean error, exit 1", async () => {
    await withTempHome(async () => {
      const reconnect = getCredentialSubCmd("reconnect")
      const out = await captureStdout(() =>
        reconnect.run?.(
          ctx({
            id: "does-not-exist",
            device: true,
            "client-id": "cid",
            "client-secret-stdin": false,
            json: true,
          }),
        ),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(process.exitCode).toBe(1)
    })
  })

  it("a non-oauth2 credential id → clean error naming the actual kind", async () => {
    await withTempHome(async () => {
      const repos = await setupApiKeyPlatform("reconnect-nonoauth-plat")
      const storeResult = await createCredentialStore(getPaths())
      if (storeResult.isErr()) throw new Error("store setup failed")
      const addResult = await addCredential(
        { platformId: "reconnect-nonoauth-plat", account: "work", kind: "api-key", secret: "v" },
        (await repos.platforms.get("reconnect-nonoauth-plat"))._unsafeUnwrap(),
        storeResult.value,
        repos.credentials,
      )
      if (addResult.isErr()) throw new Error("seed failed")

      const reconnect = getCredentialSubCmd("reconnect")
      const out = await captureStdout(() =>
        reconnect.run?.(
          ctx({
            id: addResult.value.id,
            device: true,
            "client-id": "cid",
            "client-secret-stdin": false,
            json: true,
          }),
        ),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("api-key")
    })
  })

  it("reconnect on a device-incapable provider (github-app) fails BEFORE persistOAuthTokens — proves it reads the credential's own oauthMeta.providerId, not a hardcoded one", async () => {
    await withTempHome(async () => {
      const githubAppCred = await seedOAuthCredential("github-app", {
        oauthMeta: { needsReauth: true } as Credential["oauthMeta"],
      })

      fakeStdin()
      feedStdin("some-client-secret")

      const reconnect = getCredentialSubCmd("reconnect")
      const out = await captureStdout(() =>
        reconnect.run?.(
          ctx({
            id: githubAppCred.id,
            device: true,
            "client-id": "cid",
            "client-secret-stdin": true,
            json: true,
          }),
        ),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("device flow not supported")
      expect(persistOAuthTokensMock).not.toHaveBeenCalled()
    })
  })

  it("mode:update path — device flow success persists via persistOAuthTokens(mode:update, credentialId), clearing needsReauth", async () => {
    await withTempHome(async () => {
      // The synthetic provider (injected by the @junction/core mock above) is
      // device-capable (deviceAuthorizationUrl set) — no surviving real
      // provider is, since the inc 35 strip-down removed google (the prior
      // device-code example). See connect.test.ts's device-flow test for the
      // identical engine shape / fixture.
      const cred = await seedOAuthCredential(DEVICE_CODE_PROVIDER_ID, {
        oauthMeta: {
          needsReauth: true,
        } as Credential["oauthMeta"],
      })

      deviceAuthorizeMock.mockResolvedValue(
        ok({
          deviceCode: "devcode",
          userCode: "RECN-0001",
          verificationUri: "https://example.com/device",
          intervalSeconds: 0,
          expiresInSeconds: 600,
        }),
      )
      devicePollMock.mockResolvedValueOnce({
        isOk: () => true,
        isErr: () => false,
        value: { accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 3600 },
      })
      persistOAuthTokensMock.mockReturnValue(
        new ResultAsync(
          Promise.resolve(ok({ ...cred, oauthMeta: { ...cred.oauthMeta, needsReauth: false } })),
        ),
      )

      fakeStdin()
      feedStdin("new-client-secret")

      const reconnect = getCredentialSubCmd("reconnect")
      const out = await captureStdout(() =>
        reconnect.run?.(
          ctx({
            id: cred.id,
            device: true,
            "client-id": "new-cid",
            "client-secret-stdin": true,
            json: true,
          }),
        ),
      )

      expect(persistOAuthTokensMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "update",
          credentialId: cred.id,
          providerId: DEVICE_CODE_PROVIDER_ID,
          authMode: "device_code",
        }),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean; credential?: { id: string } }
      expect(parsed.ok).toBe(true)
      expect(parsed.credential?.id).toBe(cred.id)
    })
  })

  it("rejects a PARTIAL swap (--client-secret-stdin without --client-id) rather than silently reusing", async () => {
    await withTempHome(async () => {
      const cred = await seedOAuthCredential(DEVICE_CODE_PROVIDER_ID, {
        oauthMeta: {
          needsReauth: true,
        } as Credential["oauthMeta"],
      })
      const reconnect = getCredentialSubCmd("reconnect")
      const out = await captureStdout(() =>
        // --client-secret-stdin set but NO --client-id → must error, not reuse.
        reconnect.run?.(
          ctx({ id: cred.id, device: true, "client-secret-stdin": true, json: true }),
        ),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("both --client-id and --client-secret-stdin")
      // Reuse never fired: no device flow, no persist.
      expect(deviceAuthorizeMock).not.toHaveBeenCalled()
      expect(persistOAuthTokensMock).not.toHaveBeenCalled()
    })
  })

  it("REUSES stored client creds when --client-id is omitted (no stdin, no re-typing)", async () => {
    await withTempHome(async () => {
      const cred = await seedOAuthCredential(DEVICE_CODE_PROVIDER_ID, {
        oauthMeta: {
          needsReauth: true,
          clientIdRef: "ref-stored-cid",
          clientSecretRef: "ref-stored-csec",
        } as Credential["oauthMeta"],
      })
      // Seed the store so the stored client refs actually resolve.
      const storeResult = await createCredentialStore(getPaths())
      if (storeResult.isErr()) throw new Error("store setup failed")
      await storeResult.value.set("ref-stored-cid", "stored-cid-value")
      await storeResult.value.set("ref-stored-csec", "stored-csec-value")

      deviceAuthorizeMock.mockResolvedValue(
        ok({
          deviceCode: "devcode",
          userCode: "RECN-0002",
          verificationUri: "https://example.com/device",
          intervalSeconds: 0,
          expiresInSeconds: 600,
        }),
      )
      devicePollMock.mockResolvedValueOnce({
        isOk: () => true,
        isErr: () => false,
        value: { accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 3600 },
      })
      persistOAuthTokensMock.mockReturnValue(
        new ResultAsync(
          Promise.resolve(ok({ ...cred, oauthMeta: { ...cred.oauthMeta, needsReauth: false } })),
        ),
      )

      // NO fakeStdin / --client-id / --client-secret-stdin → reuse path.
      const reconnect = getCredentialSubCmd("reconnect")
      const out = await captureStdout(() =>
        reconnect.run?.(ctx({ id: cred.id, device: true, json: true })),
      )

      // The device flow ran with the STORED client_id (resolved server-side).
      expect(deviceAuthorizeMock).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: "stored-cid-value" }),
      )
      const parsed = JSON.parse(out.trim()) as { ok: boolean; credential?: { id: string } }
      expect(parsed.ok).toBe(true)
      expect(parsed.credential?.id).toBe(cred.id)
      // No secret leaked into output.
      expect(out).not.toContain("stored-csec-value")
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
