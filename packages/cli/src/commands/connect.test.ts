// SPDX-License-Identifier: AGPL-3.0-only
// CLI edge tests for `junction connect` (increment 29, slice D).
//
// CRITICAL: the sentinel-secret test verifies client_secret NEVER appears in
// any output stream (stdout/stderr) across every code path this file drives.
//
// The connect engine (@junction/source-runtime's buildAuthorizeUrl,
// exchangeCode, deviceAuthorize, devicePoll, persistOAuthTokens) is MOCKED —
// no real HTTP, no real browser. @junction/core's openInBrowser is also
// mocked (it would otherwise spawn a real `open`/`xdg-open` process).

import { PassThrough } from "node:stream"
import {
  createRepositories,
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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const openInBrowserMock = vi.fn()
vi.mock("@junction/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/core")>()
  // Lazy wrapper (not a direct `openInBrowserMock` reference) — vi.mock
  // factories are hoisted above this file's top-level `const`s, so a direct
  // reference would TDZ-crash; deferring the lookup to call time works
  // because openInBrowserMock is defined by the time openInBrowser actually
  // runs (mirrors credential-verify-honesty.test.ts's lazy-closure pattern).
  return { ...actual, openInBrowser: (url: string) => openInBrowserMock(url) }
})

const buildAuthorizeUrlMock = vi.fn()
const exchangeCodeMock = vi.fn()
const deviceAuthorizeMock = vi.fn()
const devicePollMock = vi.fn()
const persistOAuthTokensMock = vi.fn()

vi.mock("@junction/source-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@junction/source-runtime")>()
  return {
    ...actual,
    buildAuthorizeUrl: (...args: unknown[]) => buildAuthorizeUrlMock(...args),
    exchangeCode: (...args: unknown[]) => exchangeCodeMock(...args),
    deviceAuthorize: (...args: unknown[]) => deviceAuthorizeMock(...args),
    devicePoll: (...args: unknown[]) => devicePollMock(...args),
    persistOAuthTokens: (...args: unknown[]) => persistOAuthTokensMock(...args),
  }
})

const { connectCommand, formatOAuthConnectError } = await import("./connect.js")

// ---------------------------------------------------------------------------
// Test helpers — mirrors credential.test.ts's ctx()/captureStdout()/setup pattern.
// ---------------------------------------------------------------------------

/** Minimal citty run context — matches what citty passes to run(). */
function ctx<T extends Record<string, unknown>>(args: T, rawArgs: string[] = []) {
  return { args, cmd: {} as never, rawArgs }
}

/** Capture everything written to both stdout and stderr during fn(). */
async function captureAllOutput(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = ""
  let stderr = ""
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
    return true
  }) as NodeJS.WriteStream["write"]
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
    return true
  }) as NodeJS.WriteStream["write"]
  try {
    await fn()
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  return { stdout, stderr }
}

// ---------------------------------------------------------------------------
// stdin faking — the real process.stdin is a process-wide singleton that,
// once ended (EOF), can NEVER be fed again; a bare emit("data"/"end") is
// also unsafe (any listeners LEFT ATTACHED from a previous test would have
// already consumed a real EOF, or a synthetic emit could fire before the
// current call's listener is even attached — both were observed hanging).
// Swapping in a fresh PassThrough per test sidesteps all of that: connect.ts
// reads whatever `process.stdin` currently references, so each test gets an
// isolated, freshly-endable stream.
// ---------------------------------------------------------------------------

const realStdin = process.stdin

/** Swap in a fresh fake stdin for one test; restored by the afterEach below. */
function fakeStdin(): PassThrough {
  const fake = new PassThrough()
  Object.defineProperty(process, "stdin", { value: fake, configurable: true })
  return fake
}

/** Feed a fixed string to the current fake stdin as if piped (--client-secret-stdin). */
function feedStdin(value: string): void {
  const stdin = process.stdin as unknown as PassThrough
  stdin.end(value)
}

/** Upsert an oauth2-scheme openapi platform (github's shape) into the temp-home DB. */
async function setupOAuthPlatform(platformId: string) {
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
  })
  await repos.platforms.upsert(platform)
  return repos
}

const NORMALIZED_TOKENS = {
  accessToken: "access-abc",
  refreshToken: "refresh-abc",
  expiresInSeconds: 3600,
  scopes: ["read"],
}

function fakeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred-1",
    platformId: "github",
    profileName: "default",
    kind: "oauth2" as const,
    secretRef: "ref-access",
    oauthMeta: { providerId: "github", needsReauth: false },
    ...overrides,
  }
}

describe("junction connect (unit)", () => {
  let prevExitCode: number | undefined

  let prevNoSleep: string | undefined
  beforeEach(() => {
    prevExitCode = process.exitCode
    process.exitCode = 0
    // Collapse the device-poll loop's (5s-floored) sleeps to instant — the real
    // floor still applies in production; this only affects wall-clock in tests.
    prevNoSleep = process.env.JUNCTION_TEST_NO_SLEEP
    process.env.JUNCTION_TEST_NO_SLEEP = "1"
    openInBrowserMock.mockReset()
    buildAuthorizeUrlMock.mockReset()
    exchangeCodeMock.mockReset()
    deviceAuthorizeMock.mockReset()
    devicePollMock.mockReset()
    persistOAuthTokensMock.mockReset()
  })

  afterEach(() => {
    process.exitCode = prevExitCode
    if (prevNoSleep === undefined) delete process.env.JUNCTION_TEST_NO_SLEEP
    else process.env.JUNCTION_TEST_NO_SLEEP = prevNoSleep
    Object.defineProperty(process, "stdin", { value: realStdin, configurable: true })
  })

  it("unknown provider → clean error, exit 1, --json shaped", async () => {
    await withTempHome(async () => {
      await setupOAuthPlatform("not-a-real-provider")

      const { stdout } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "not-a-real-provider",
            account: "work",
            device: false,
            "client-id": "cid",
            "client-secret-stdin": false,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("unknown OAuth provider")
      expect(process.exitCode).toBe(1)
      expect(openInBrowserMock).not.toHaveBeenCalled()
    })
  })

  it("known provider but no platform row → DB not-found error, never reaches the flow", async () => {
    await withTempHome(async () => {
      // "github" resolves in the catalog but no platform row exists.
      const { stdout } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "github",
            account: "work",
            device: false,
            "client-id": "cid",
            "client-secret-stdin": false,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(process.exitCode).toBe(1)
      expect(buildAuthorizeUrlMock).not.toHaveBeenCalled()
      expect(deviceAuthorizeMock).not.toHaveBeenCalled()
    })
  })

  it("guided registration hint is printed in human mode", async () => {
    await withTempHome(async () => {
      await setupOAuthPlatform("github")

      const infoSpy = vi.spyOn(consola, "info").mockImplementation(() => undefined as never)
      try {
        await connectCommand.run?.(
          ctx({
            platform: "github",
            account: "work",
            device: false, // github is loopback-fixed → will be refused, but the hint prints first
            "client-id": undefined,
            "client-secret-stdin": false,
            json: false,
          }),
        )

        const printed = infoSpy.mock.calls.map((c) => String(c[0])).join("\n")
        expect(printed).toContain("Register an OAuth app for GitHub")
        expect(printed).toContain("redirect URI:")
        expect(printed).toContain("http://127.0.0.1:4321/oauth/callback")
      } finally {
        infoSpy.mockRestore()
      }
    })
  })

  it("loopback-fixed provider (github) without --device → honest refusal, not a faked browser flow", async () => {
    await withTempHome(async () => {
      await setupOAuthPlatform("github")
      fakeStdin()
      feedStdin("sentinel-client-secret-value")

      const { stdout, stderr } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "github",
            account: "work",
            device: false,
            "client-id": "cid",
            "client-secret-stdin": true,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("does not support")
      expect(parsed.error).toContain("--device")
      expect(openInBrowserMock).not.toHaveBeenCalled()
      expect(stdout).not.toContain("sentinel-client-secret-value")
      expect(stderr).not.toContain("sentinel-client-secret-value")
    })
  })

  it("device flow: pending → slow-down → success, persists via mode:create", async () => {
    await withTempHome(async () => {
      // google has deviceAuthorizationUrl set (unlike github's OAuth-App entry) —
      // the device flow is only offered where the catalog declares it.
      await setupOAuthPlatform("google")
      fakeStdin()
      feedStdin("sentinel-client-secret-value")

      deviceAuthorizeMock.mockResolvedValue(
        ok({
          deviceCode: "devcode",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          intervalSeconds: 0, // real loop floors this to 5s; JUNCTION_TEST_NO_SLEEP makes the sleeps instant
          expiresInSeconds: 600,
        }),
      )
      devicePollMock
        .mockResolvedValueOnce({
          isOk: () => false,
          isErr: () => true,
          error: { kind: "device-pending" },
        })
        .mockResolvedValueOnce({
          isOk: () => false,
          isErr: () => true,
          error: { kind: "device-slow-down" },
        })
        .mockResolvedValueOnce({ isOk: () => true, isErr: () => false, value: NORMALIZED_TOKENS })

      persistOAuthTokensMock.mockReturnValue(
        new ResultAsync(Promise.resolve(ok(fakeCredential({ platformId: "google" })))),
      )

      const { stdout, stderr } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "google",
            account: "work",
            device: true,
            "client-id": "cid",
            "client-secret-stdin": true,
            json: true,
          }),
        ),
      )

      expect(devicePollMock).toHaveBeenCalledTimes(3)
      expect(persistOAuthTokensMock).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "create", authMode: "device_code", platformId: "google" }),
      )
      const lines = stdout.trim().split("\n")
      const last = JSON.parse(lines[lines.length - 1]) as {
        ok: boolean
        credential?: { id: string }
      }
      expect(last.ok).toBe(true)
      expect(last.credential?.id).toBe("cred-1")
      expect(stdout).not.toContain("sentinel-client-secret-value")
      expect(stderr).not.toContain("sentinel-client-secret-value")
    })
  })

  it("device flow not supported for a provider without deviceAuthorizationUrl → clean error", async () => {
    await withTempHome(async () => {
      await setupOAuthPlatform("notion")
      fakeStdin()
      feedStdin("sentinel-client-secret-value")

      const { stdout } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "notion",
            account: "work",
            device: true,
            "client-id": "cid",
            "client-secret-stdin": true,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("device flow not supported")
      expect(deviceAuthorizeMock).not.toHaveBeenCalled()
    })
  })

  it("missing --client-id → clean error before stdin is ever read", async () => {
    await withTempHome(async () => {
      await setupOAuthPlatform("github")

      const { stdout } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "github",
            account: "work",
            device: true,
            "client-id": undefined,
            "client-secret-stdin": true,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("--client-id")
      expect(deviceAuthorizeMock).not.toHaveBeenCalled()
    })
  })

  it("--client-secret-stdin omitted → clean error, client_secret is never accepted via a flag", async () => {
    await withTempHome(async () => {
      await setupOAuthPlatform("github")

      const { stdout } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "github",
            account: "work",
            device: true,
            "client-id": "cid",
            "client-secret-stdin": false,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("--client-secret-stdin")
      expect(deviceAuthorizeMock).not.toHaveBeenCalled()
    })
  })

  it("state-mismatch on the browser callback (real ephemeral loopback listener) → typed error, exchangeCode never called", async () => {
    await withTempHome(async () => {
      await setupOAuthPlatform("google") // loopback-ephemeral — browser flow is offered
      fakeStdin()
      feedStdin("sentinel-client-secret-value")

      // buildAuthorizeUrl is called with the REAL redirectUri connect.ts
      // derived from the ephemeral listener's bound port — capture it so
      // this test can hit that exact listener with a forged `state`.
      buildAuthorizeUrlMock.mockImplementation((callArgs: { redirectUri: string }) => {
        capturedRedirectUri = callArgs.redirectUri
        return {
          url: "https://accounts.google.com/o/oauth2/v2/auth?mock=1",
          state: "expected-state",
          codeVerifier: "verifier-abc",
        }
      })
      let capturedRedirectUri: string | undefined

      // openInBrowser is mocked to, instead of opening a real browser, fire
      // a real HTTP GET at the real ephemeral listener with a WRONG `state`
      // — the exact CSRF scenario runBrowserFlow's closure must reject.
      openInBrowserMock.mockImplementation(() => {
        void (async () => {
          if (!capturedRedirectUri) throw new Error("redirectUri not captured")
          const { get } = await import("node:http")
          get(`${capturedRedirectUri}?code=some-code&state=WRONG-STATE`, (res) => res.resume())
        })()
      })

      const { stdout } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "google",
            account: "work",
            device: false,
            "client-id": "cid",
            "client-secret-stdin": true,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("state mismatch")
      expect(exchangeCodeMock).not.toHaveBeenCalled()
      expect(stdout).not.toContain("sentinel-client-secret-value")
    })
  })

  it("openInBrowser throwing (no browser available) → clean typed error, not a hang", async () => {
    await withTempHome(async () => {
      await setupOAuthPlatform("google") // loopback-ephemeral — browser flow is offered
      fakeStdin()
      feedStdin("sentinel-client-secret-value")

      buildAuthorizeUrlMock.mockReturnValue({
        url: "https://accounts.google.com/o/oauth2/v2/auth?mock=1",
        state: "expected-state",
        codeVerifier: "verifier-abc",
      })
      // Simulate a headless box / no browser: openInBrowser throws SYNCHRONOUSLY
      // inside the listener handler. Without the try/catch in that handler the
      // Promise would never resolve → the CLI hangs until the 5-min deadline.
      openInBrowserMock.mockImplementation(() => {
        throw new Error("no browser available")
      })

      const { stdout } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "google",
            account: "work",
            device: false,
            "client-id": "cid",
            "client-secret-stdin": true,
            json: true,
          }),
        ),
      )

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      // A typed exchange-failed error, resolved promptly (no hang), no secret.
      expect(parsed.error).toContain("token exchange failed")
      expect(exchangeCodeMock).not.toHaveBeenCalled()
      expect(stdout).not.toContain("sentinel-client-secret-value")
    })
  })

  it("--json emits registration hint fields, no secret anywhere in stdout/stderr (sentinel sweep)", async () => {
    await withTempHome(async () => {
      await setupOAuthPlatform("google") // device-capable (see the flow test above)
      fakeStdin()
      feedStdin("SUPER-SECRET-SENTINEL-VALUE")

      deviceAuthorizeMock.mockResolvedValue(
        ok({
          deviceCode: "devcode",
          userCode: "WXYZ-9999",
          verificationUri: "https://www.google.com/device",
          intervalSeconds: 0,
          expiresInSeconds: 600,
        }),
      )
      devicePollMock.mockResolvedValueOnce({
        isOk: () => true,
        isErr: () => false,
        value: NORMALIZED_TOKENS,
      })
      persistOAuthTokensMock.mockReturnValue(new ResultAsync(Promise.resolve(ok(fakeCredential()))))

      const { stdout, stderr } = await captureAllOutput(() =>
        connectCommand.run?.(
          ctx({
            platform: "google",
            account: "work",
            device: true,
            "client-id": "cid",
            "client-secret-stdin": true,
            json: true,
          }),
        ),
      )

      expect(stdout).not.toContain("SUPER-SECRET-SENTINEL-VALUE")
      expect(stderr).not.toContain("SUPER-SECRET-SENTINEL-VALUE")
      // The client_secret was passed to the mocked persist call directly
      // (in-memory args), never serialized to an output stream — assert the
      // call args contain it (proving the flow DID have the value) while the
      // captured streams above prove it never escaped to output.
      expect(persistOAuthTokensMock).toHaveBeenCalledWith(
        expect.objectContaining({ clientSecret: "SUPER-SECRET-SENTINEL-VALUE" }),
      )
    })
  })
})

// ---------------------------------------------------------------------------
// formatOAuthConnectError — 32.13 Slice B1: duplicate-account surfaces as a
// specific, non-misleading message (not the generic "persist-failed").
// ---------------------------------------------------------------------------

describe("formatOAuthConnectError — duplicate-account (32.13 Slice B1)", () => {
  it("surfaces a typed duplicate-account message naming the account, not generic persist-failed text", () => {
    const message = formatOAuthConnectError({
      kind: "duplicate-account",
      platformId: "github",
      account: "work",
    })
    expect(message).toContain("work")
    expect(message).toContain("already connected")
    expect(message).not.toContain("persist-failed")
    expect(message).not.toContain("failed to persist")
  })

  it("still formats persist-failed distinctly (unchanged sibling branch)", () => {
    const message = formatOAuthConnectError({
      kind: "persist-failed",
      cause: { kind: "query-failed", cause: "boom" },
    })
    expect(message).toContain("failed to persist tokens")
  })
})
