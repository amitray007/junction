// SPDX-License-Identifier: AGPL-3.0-only
// Tests for the verify-honesty fixes on `junction credential test`:
//
// Fix 1 (MEDIUM): a stored credential whose secret resolves to null (lost
// keychain entry / deleted key file) must NEVER be handed to verifyCredential
// as a null secret — that would silently mean "verify with no credential
// sent," which can come back "ok" against an anonymous-accepting upstream.
// The outcome must be "unreachable" with STORED_SECRET_MISSING_DETAIL, and
// verifyCredential must never be called on this path.
//
// Fix 2 (LOW): `repos.credentials.setVerifyState`'s Result was previously
// discarded — an Err (DB write failure/race) still printed "verify: ok" with
// no signal that persistence silently failed. The command must still exit 0
// (storing succeeded; only the persist-of-the-verify-outcome step failed),
// but must emit a stderr warning in human mode and `persisted: false` in
// --json.
//
// Both mocks are scoped to this file only (vi.mock is file-scoped) — the
// existing credential.test.ts suite is untouched and keeps exercising the
// real store/DB paths.

import {
  createRepositories as actualCreateRepositories,
  addCredential,
  err,
  getDatabase,
  getPaths,
  ok,
  PlatformIdSchema,
  PlatformSchema,
  ResultAsync,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { consola } from "consola"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** Build an Ok(value) as a ResultAsync — mirrors neverthrow's okAsync without a direct dep. */
function okAsync<T, E = never>(value: T): ResultAsync<T, E> {
  return new ResultAsync(Promise.resolve(ok(value)))
}

/** Build an Err(error) as a ResultAsync — mirrors neverthrow's errAsync without a direct dep. */
function errAsync<T = never, E = unknown>(error: E): ResultAsync<T, E> {
  return new ResultAsync(Promise.resolve(err(error)))
}

// ---------------------------------------------------------------------------
// Mocks — @junction/core's createCredentialStore (force store.get → null) and
// createRepositories (force setVerifyState → Err on demand, real otherwise),
// plus @junction/source-runtime's verifyCredential (assert never-called).
// ---------------------------------------------------------------------------

const storeGetMock = vi.fn()
const verifyCredentialMock = vi.fn()
let forceSetVerifyStateErr = false

vi.mock("@junction/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/core")>()
  return {
    ...actual,
    createCredentialStore: vi.fn(async () =>
      okAsync({
        backend: "encrypted-file" as const,
        get: storeGetMock,
        set: vi.fn(async () => okAsync(undefined)),
        delete: vi.fn(async () => okAsync(undefined)),
      }),
    ),
    createRepositories: vi.fn((db: Parameters<typeof actual.createRepositories>[0]) => {
      const real = actual.createRepositories(db)
      return {
        ...real,
        credentials: {
          ...real.credentials,
          setVerifyState: (...args: Parameters<typeof real.credentials.setVerifyState>) => {
            if (forceSetVerifyStateErr) {
              return errAsync({ kind: "query-failed", cause: new Error("simulated DB failure") })
            }
            return real.credentials.setVerifyState(...args)
          },
        },
      }
    }),
  }
})

vi.mock("@junction/source-runtime", () => ({
  verifyCredential: (...args: unknown[]) => verifyCredentialMock(...args),
}))

const { credentialCommand } = await import("./credential.js")

afterEach(() => {
  storeGetMock.mockReset()
  verifyCredentialMock.mockReset()
  forceSetVerifyStateErr = false
})

// ---------------------------------------------------------------------------
// Test helpers (mirrors credential.test.ts's ctx/captureStdout/getCredentialSubCmd)
// ---------------------------------------------------------------------------

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

function ctx<T extends Record<string, unknown>>(args: T) {
  return { args, cmd: {} as never, rawArgs: [] as string[] }
}

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

/** Seed a platform + a real stored credential (via the real store) into the temp-home DB. */
async function seedCredential(platformId: string) {
  const dbResult = await getDatabase(getPaths())
  if (dbResult.isErr()) throw new Error(`DB error: ${dbResult.error.kind}`)
  const repos = actualCreateRepositories(dbResult.value)
  const platform = PlatformSchema.parse({
    id: PlatformIdSchema.parse(platformId),
    kind: "openapi" as const,
    displayName: "Verify Honesty Platform",
    openapi: {
      spec: { from: "url" as const, url: "https://example.com/openapi.json" },
      auth: { scheme: "apiKey" as const, in: "header" as const, name: "X-Api-Key" },
    },
  })
  await repos.platforms.upsert(platform)

  // Use the REAL store (not the mocked one) to actually persist a secret + row,
  // since createCredentialStore is mocked module-wide for this file. We only
  // need a real credential row with a secretRef — the mocked store.get is what
  // the command under test will call, and we control its return value per-test.
  const { createCredentialStore: actualCreateCredentialStore } =
    await vi.importActual<typeof import("@junction/core")>("@junction/core")
  const storeResult = await actualCreateCredentialStore(getPaths())
  if (storeResult.isErr()) throw new Error("real store setup failed")

  const addResult = await addCredential(
    { platformId, account: "work", kind: "api-key", secret: "seed-secret-value" },
    platform,
    storeResult.value,
    repos.credentials,
  )
  if (addResult.isErr()) throw new Error("seed credential add failed")
  return addResult.value
}

describe("credential test — lost-secret honesty (Fix 1)", () => {
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

  it('store.get resolving Ok(null) for a stored credential → outcome "unreachable" with stored-secret-missing detail, verifyCredential NEVER called, persisted as unreachable (not ok)', async () => {
    await withTempHome(async () => {
      const credential = await seedCredential("lost-secret-plat")

      // Simulate the secret having vanished from the store (cleared keychain /
      // deleted key file) — store.get resolves Ok(null) for this stored ref.
      storeGetMock.mockReturnValue(okAsync(null))

      const testCmd = getCredentialSubCmd("test")
      const out = await captureStdout(() => testCmd.run?.(ctx({ id: credential.id, json: true })))

      const parsed = JSON.parse(out.trim()) as {
        ok: boolean
        verify?: { status: string; detail?: string }
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.verify?.status).toBe("unreachable")
      expect(parsed.verify?.detail).toContain("stored secret missing")
      expect(process.exitCode).toBe(0)

      // NO anonymous verify happened — verifyCredential was never invoked.
      expect(verifyCredentialMock).not.toHaveBeenCalled()

      // Persisted as "unreachable", never "ok" or "auth-failed".
      const dbResult = await getDatabase(getPaths())
      if (dbResult.isErr()) throw new Error("db reopen failed")
      const repos = actualCreateRepositories(dbResult.value)
      const reread = await repos.credentials.get(credential.id)
      if (reread.isErr()) throw new Error("credential reread failed")
      expect(reread.value.lastVerifyResult).toBe("unreachable")
    })
  })

  it("human mode: prints the stored-secret-missing detail and never calls verifyCredential", async () => {
    await withTempHome(async () => {
      const credential = await seedCredential("lost-secret-human-plat")
      storeGetMock.mockReturnValue(okAsync(null))

      const infoSpy = vi.spyOn(consola, "info").mockImplementation(() => undefined)
      try {
        const testCmd = getCredentialSubCmd("test")
        await testCmd.run?.(ctx({ id: credential.id, json: false }))

        const printed = infoSpy.mock.calls.map((c) => String(c[0])).join("\n")
        expect(printed).toContain("unreachable")
        expect(printed).toContain("stored secret missing")
        expect(verifyCredentialMock).not.toHaveBeenCalled()
      } finally {
        infoSpy.mockRestore()
      }
    })
  })
})

describe("credential test — setVerifyState persistence failure surfaced, not swallowed (Fix 2)", () => {
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

  it("setVerifyState Err during `credential test` → command still exits 0, --json carries persisted:false", async () => {
    await withTempHome(async () => {
      const credential = await seedCredential("persist-fail-plat")
      storeGetMock.mockReturnValue(okAsync("real-secret-value"))
      verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
      forceSetVerifyStateErr = true

      const testCmd = getCredentialSubCmd("test")
      const out = await captureStdout(() => testCmd.run?.(ctx({ id: credential.id, json: true })))

      const parsed = JSON.parse(out.trim()) as {
        ok: boolean
        verify?: { status: string }
        persisted?: boolean
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.verify?.status).toBe("ok")
      expect(parsed.persisted).toBe(false)
      expect(process.exitCode).toBe(0)
    })
  })

  it("setVerifyState Err during `credential test` (human mode) → warning printed via consola.warn, exit 0", async () => {
    await withTempHome(async () => {
      const credential = await seedCredential("persist-fail-human-plat")
      storeGetMock.mockReturnValue(okAsync("real-secret-value"))
      verifyCredentialMock.mockReturnValue(okAsync({ status: "ok" }))
      forceSetVerifyStateErr = true

      const warnSpy = vi.spyOn(consola, "warn").mockImplementation(() => undefined)
      try {
        const testCmd = getCredentialSubCmd("test")
        await testCmd.run?.(ctx({ id: credential.id, json: false }))

        const printed = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
        expect(printed).toContain("could not persist the verify result")
        expect(process.exitCode).toBe(0)
      } finally {
        warnSpy.mockRestore()
      }
    })
  })
})
