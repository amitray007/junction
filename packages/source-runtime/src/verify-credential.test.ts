// SPDX-License-Identifier: AGPL-3.0-only
// verifyCredential tests — mock providers per kind covering every outcome
// (ok / auth-failed / unreachable / not-verifiable), plus a serialize-the-outcome
// assert proving no secret/URL/body ever rides in a VerifyOutcome.
//
// buildProvider (the only seam verifyCredential calls) is mocked so these tests
// never touch real network/transport code — that's covered by graphql-client's
// and mcp-client's own test suites (401/403 mapping, header injection, etc.).

import type { JunctionPaths, Platform, ToolProvider } from "@junction/core"
import { err, ok, ResultAsync } from "@junction/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildProvider } from "./build-provider.js"
import { verifyCredential } from "./verify-credential.js"

vi.mock("./build-provider.js", () => ({
  buildProvider: vi.fn(),
}))

const FAKE_PATHS = {} as JunctionPaths

function mcpPlatform(): Platform {
  return {
    id: "plat-mcp",
    kind: "mcp",
    displayName: "MCP Test",
    connection: { transport: "http", url: "https://example.com/mcp" },
  }
}

function graphqlPlatform(): Platform {
  return {
    id: "plat-gql",
    kind: "graphql",
    displayName: "GraphQL Test",
    graphql: { endpoint: "https://example.com/graphql" },
  }
}

function openapiPlatform(verifyOperationId?: string): Platform {
  return {
    id: "plat-oapi",
    kind: "openapi",
    displayName: "OpenAPI Test",
    openapi: {
      spec: { from: "url", url: "https://example.com/openapi.json" },
      ...(verifyOperationId !== undefined ? { verifyOperationId } : {}),
    },
  }
}

function cliPlatform(): Platform {
  return {
    id: "plat-cli",
    kind: "cli",
    displayName: "CLI Test",
    cli: {
      tools: [
        {
          name: "run",
          argv: [{ kind: "literal", value: "/bin/true" }],
          policy: { cwd: "/tmp", readPaths: [], writePaths: [], allowNet: [], timeoutMs: 1000 },
        },
      ],
    },
  }
}

function stubProvider(overrides: Partial<ToolProvider>): ToolProvider {
  return {
    listTools: () => new ResultAsync(Promise.resolve(ok([]))),
    callTool: () => new ResultAsync(Promise.resolve(ok({ content: [], isError: false }))),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

afterEach(() => {
  vi.mocked(buildProvider).mockReset()
})

describe("verifyCredential — cli", () => {
  it("always not-verifiable (running a command has side effects)", async () => {
    const result = await verifyCredential(cliPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual({
        status: "not-verifiable",
        reason: "running a command has side effects",
      })
    }
    expect(buildProvider).not.toHaveBeenCalled()
  })
})

describe("verifyCredential — custom (GAP-3b, inc 28.95)", () => {
  it("always not-verifiable — reachable via PlatformKind's 'custom' member, never calls buildProvider", async () => {
    // PlatformKind = "mcp" | "openapi" | "graphql" | "cli" | "custom" (schema/platform.ts).
    // "custom" is a real, reachable member of the union (unlike a hypothetical
    // future kind, which the `const _: never` exhaustiveness guard would catch
    // at compile time) — so this branch is genuinely exercisable, not vacuous.
    const platform: Platform = {
      id: "plat-custom",
      kind: "custom",
      displayName: "Custom Source",
    }
    const result = await verifyCredential(platform, "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual({
        status: "not-verifiable",
        reason: `platform kind "custom" is not verifiable`,
      })
    }
    expect(buildProvider).not.toHaveBeenCalled()
  })
})

describe("verifyCredential — openapi", () => {
  it("not-verifiable when verifyOperationId is unset", async () => {
    const result = await verifyCredential(openapiPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.status).toBe("not-verifiable")
    }
    expect(buildProvider).not.toHaveBeenCalled()
  })

  it("ok on a 2xx response", async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({ content: [{ type: "text", text: "200 OK\n{}" }], isError: false }),
                  ),
                ),
              close,
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(openapiPlatform("getMe"), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "ok" })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("auth-failed on a parsed 401/403 status line", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({
                      content: [{ type: "text", text: "401 Unauthorized\n{}" }],
                      isError: true,
                    }),
                  ),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(openapiPlatform("getMe"), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "auth-failed" })
  })

  it("unreachable on a non-auth error status (e.g. 500)", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({
                      content: [{ type: "text", text: "500 Internal Server Error\nboom" }],
                      isError: true,
                    }),
                  ),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(openapiPlatform("getMe"), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.status).toBe("unreachable")
      if (result.value.status === "unreachable") expect(result.value.detail).toBe("HTTP 500")
    }
  })

  it("discards the response body — the outcome never carries it", async () => {
    const SECRET_BODY_MARKER = "super-secret-response-body-content"
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({
                      content: [{ type: "text", text: `200 OK\n${SECRET_BODY_MARKER}` }],
                      isError: false,
                    }),
                  ),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(openapiPlatform("getMe"), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(JSON.stringify(result.value)).not.toContain(SECRET_BODY_MARKER)
    }
  })

  it("unreachable — 'unexpected response shape' when the ToolResult text has no parseable leading status line (GAP-3a, inc 28.95)", async () => {
    // parseLeadingStatus requires a leading /^(\d{3})\s/ match; text that doesn't
    // start with a 3-digit status code (e.g. a shape openapi-client never
    // actually emits, but the code defends against) hits this specific detail.
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({ content: [{ type: "text", text: "not a status line at all" }] }),
                  ),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(openapiPlatform("getMe"), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual({ status: "unreachable", detail: "unexpected response shape" })
    }
  })

  it("unreachable when buildProvider itself fails (e.g. missing spec cache)", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(Promise.resolve(err({ kind: "connect-failed", cause: "ENOENT" }))),
    )
    const result = await verifyCredential(openapiPlatform("getMe"), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.status).toBe("unreachable")
  })

  it("closes the provider even when callTool throws an Err (finally)", async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(Promise.resolve(err({ kind: "auth-failed" as const }))),
              close,
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(openapiPlatform("getMe"), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "auth-failed" })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('calls callTool with the SANITIZED operationId, not the raw one (a dotted id like "users.me" must verify against the sanitized tool name openapi-client\'s runtime actually registers)', async () => {
    const callTool = vi.fn(
      () =>
        new ResultAsync(
          Promise.resolve(ok({ content: [{ type: "text", text: "200 OK\n{}" }], isError: false })),
        ),
    )
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(Promise.resolve(ok(stubProvider({ callTool })))),
    )
    const result = await verifyCredential(openapiPlatform("users.me"), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "ok" })
    expect(callTool).toHaveBeenCalledWith("users_me", {})
  })

  it("closes the provider and still resolves Ok even when close() itself rejects", async () => {
    const close = vi.fn().mockRejectedValue(new Error("ECONNRESET on close"))
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({ content: [{ type: "text", text: "200 OK\n{}" }], isError: false }),
                  ),
                ),
              close,
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(openapiPlatform("getMe"), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "ok" })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe("verifyCredential — graphql", () => {
  it("ok on a clean {__typename} response", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({
                      content: [{ type: "text", text: '{"data":{"__typename":"Query"}}' }],
                      isError: false,
                    }),
                  ),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(graphqlPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "ok" })
  })

  it("auth-failed when the graphql-client layer returns a typed auth-failed Err (401/403)", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(err({ kind: "auth-failed" as const, cause: "HTTP 401" })),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(graphqlPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "auth-failed" })
  })

  it("shadow path: HTTP 200 + errors matching the auth heuristic → auth-failed", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({
                      content: [
                        {
                          type: "text",
                          text: JSON.stringify({
                            errors: [{ message: "Unauthorized: bad token" }],
                          }),
                        },
                      ],
                      isError: true,
                    }),
                  ),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(graphqlPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "auth-failed" })
  })

  it("shadow path: HTTP 200 + errors NOT matching the auth heuristic → unreachable (honest, not a fake green/red)", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({
                      content: [
                        {
                          type: "text",
                          text: JSON.stringify({ errors: [{ message: "Field X does not exist" }] }),
                        },
                      ],
                      isError: true,
                    }),
                  ),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(graphqlPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual({ status: "unreachable", detail: "graphql returned errors" })
    }
  })

  it("unreachable on a network-ish Err (not auth-failed)", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(err({ kind: "call-failed" as const, cause: "ECONNREFUSED" })),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(graphqlPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.status).toBe("unreachable")
  })
})

describe("verifyCredential — mcp (http + stdio)", () => {
  it("ok when listTools succeeds", async () => {
    vi.mocked(buildProvider).mockReturnValue(new ResultAsync(Promise.resolve(ok(stubProvider({})))))
    const result = await verifyCredential(mcpPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "ok" })
  })

  it("auth-failed when buildProvider ITSELF fails with an auth-failed kind (the real MCP-http eager-connect shape — a wrong token 401/403s at connect, before listTools ever runs)", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(Promise.resolve(err({ kind: "auth-failed" as const }))),
    )
    const result = await verifyCredential(mcpPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "auth-failed" })
  })

  it("still unreachable when buildProvider fails with a non-auth kind (e.g. connect-failed)", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(err({ kind: "connect-failed" as const, cause: "ECONNREFUSED" })),
      ),
    )
    const result = await verifyCredential(mcpPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.status).toBe("unreachable")
  })

  it("auth-failed when listTools returns a typed auth-failed Err", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              listTools: () =>
                new ResultAsync(Promise.resolve(err({ kind: "auth-failed" as const }))),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(mcpPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ status: "auth-failed" })
  })

  it("unreachable when listTools fails for a non-auth reason (e.g. connect-failed)", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              listTools: () =>
                new ResultAsync(
                  Promise.resolve(err({ kind: "connect-failed" as const, cause: "ECONNREFUSED" })),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(mcpPlatform(), "secret", FAKE_PATHS)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.status).toBe("unreachable")
  })

  it("ALWAYS closes the provider, even on the ok path (finally)", async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(Promise.resolve(ok(stubProvider({ close })))),
    )
    await verifyCredential(mcpPlatform(), "secret", FAKE_PATHS)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Secret discipline — no VerifyOutcome ever carries the secret, a URL, or a body.
// ---------------------------------------------------------------------------

describe("verifyCredential — secret/URL discipline (serialize + assert)", () => {
  const SENTINEL_SECRET = "sentinel-verify-secret-xyz789" // gitleaks:allow
  const SENTINEL_URL = "https://leaked-internal-host.example.com/mcp"

  it("mcp auth-failed outcome never contains the secret or a URL", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              listTools: () =>
                new ResultAsync(
                  Promise.resolve(
                    err({ kind: "auth-failed" as const, cause: `token=${SENTINEL_SECRET}` }),
                  ),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(
      { ...mcpPlatform(), connection: { transport: "http", url: SENTINEL_URL } },
      SENTINEL_SECRET,
      FAKE_PATHS,
    )
    expect(result.isOk()).toBe(true)
    const serialized = JSON.stringify(result.isOk() ? result.value : undefined)
    expect(serialized).not.toContain(SENTINEL_SECRET)
    expect(serialized).not.toContain(SENTINEL_URL)
    // auth-failed carries no `cause` field at all in VerifyOutcome — this
    // assertion also catches a future regression that plumbed it through.
    expect(result.isOk() ? result.value : undefined).toEqual({ status: "auth-failed" })
  })

  it("openapi unreachable outcome's detail never contains the response body", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new ResultAsync(
        Promise.resolve(
          ok(
            stubProvider({
              callTool: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok({
                      content: [
                        { type: "text", text: `500 Internal Server Error\n${SENTINEL_SECRET}` },
                      ],
                      isError: true,
                    }),
                  ),
                ),
            }),
          ),
        ),
      ),
    )
    const result = await verifyCredential(openapiPlatform("getMe"), SENTINEL_SECRET, FAKE_PATHS)
    const serialized = JSON.stringify(result.isOk() ? result.value : undefined)
    expect(serialized).not.toContain(SENTINEL_SECRET)
  })
})

// ---------------------------------------------------------------------------
// OAuth-native token check (Task 2 follow-up): when an oauth2 credential's
// providerId has a catalog userinfo endpoint, Test Connection verifies the
// TOKEN against that endpoint instead of the platform's source.
// ---------------------------------------------------------------------------

describe("verifyCredential — oauth2 identity check", () => {
  const SENTINEL = "sentinel-oauth-token-do-not-leak-abc123" // gitleaks:allow
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // A GitHub oauth2 credential attached to (say) an MCP platform whose source is
  // unreachable — the OAuth path must verify the TOKEN, never touch the source.
  function githubOAuthOpts() {
    return { oauthProviderId: "github" }
  }

  it("token check: 200 → ok (never calls buildProvider / the source)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    const result = await verifyCredential(mcpPlatform(), "tok", FAKE_PATHS, githubOAuthOpts())
    expect(result._unsafeUnwrap()).toEqual({ status: "ok" })
    expect(buildProvider).not.toHaveBeenCalled()
    // the token went in as a bearer, the source was never touched
    const call = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(String(call?.[0])).toContain("api.github.com/user")
  })

  it("token check: 401 → auth-failed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("no", { status: 401 }))
    const result = await verifyCredential(mcpPlatform(), "tok", FAKE_PATHS, githubOAuthOpts())
    expect(result._unsafeUnwrap()).toEqual({ status: "auth-failed" })
  })

  it("token check: 403 → auth-failed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("no", { status: 403 }))
    const result = await verifyCredential(mcpPlatform(), "tok", FAKE_PATHS, githubOAuthOpts())
    expect(result._unsafeUnwrap()).toEqual({ status: "auth-failed" })
  })

  it("token check: 500 → unreachable with a leak-safe HTTP-status detail", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 500 }))
    const result = await verifyCredential(mcpPlatform(), "tok", FAKE_PATHS, githubOAuthOpts())
    expect(result._unsafeUnwrap()).toEqual({ status: "unreachable", detail: "HTTP 500" })
  })

  it("token check: timeout (AbortError) → unreachable, never hangs", async () => {
    // AbortSignal.timeout fires → fetch rejects with an AbortError; the catch
    // maps it to unreachable with the leak-safe constructor name.
    globalThis.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), {
        name: "AbortError",
        constructor: { name: "DOMException" },
      }),
    )
    const result = await verifyCredential(mcpPlatform(), "tok", FAKE_PATHS, githubOAuthOpts())
    expect(result._unsafeUnwrap().status).toBe("unreachable")
  })

  it("token check: network error → unreachable with the error constructor name (never the cause message)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed to https://secret-url"))
    const result = await verifyCredential(mcpPlatform(), "tok", FAKE_PATHS, githubOAuthOpts())
    const outcome = result._unsafeUnwrap()
    expect(outcome.status).toBe("unreachable")
    if (outcome.status === "unreachable") {
      expect(outcome.detail).toBe("TypeError")
      expect(outcome.detail).not.toContain("secret-url")
    }
  })

  it("NO TOKEN LEAK: the sentinel token never appears in any outcome, across every branch", async () => {
    for (const status of [200, 401, 500]) {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status }))
      const r = await verifyCredential(mcpPlatform(), SENTINEL, FAKE_PATHS, githubOAuthOpts())
      expect(JSON.stringify(r._unsafeUnwrap())).not.toContain(SENTINEL)
    }
    globalThis.fetch = vi.fn().mockRejectedValue(new Error(SENTINEL)) // even if the cause carries it
    const r = await verifyCredential(mcpPlatform(), SENTINEL, FAKE_PATHS, githubOAuthOpts())
    expect(JSON.stringify(r._unsafeUnwrap())).not.toContain(SENTINEL)
  })

  it("FALLBACK: no oauthProviderId → source-verify path unchanged (buildProvider IS called)", async () => {
    // No opts → the oauth2 branch is skipped; an MCP platform hits buildProvider as before.
    vi.mocked(buildProvider).mockReturnValue(new ResultAsync(Promise.resolve(ok(stubProvider({})))))
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    await verifyCredential(mcpPlatform(), "tok", FAKE_PATHS)
    expect(buildProvider).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled() // the userinfo fetch never fired
  })

  it("FALLBACK: providerId with NO userinfoUrl (generic) → source-verify path (buildProvider called)", async () => {
    vi.mocked(buildProvider).mockReturnValue(new ResultAsync(Promise.resolve(ok(stubProvider({})))))
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    await verifyCredential(mcpPlatform(), "tok", FAKE_PATHS, { oauthProviderId: "generic" })
    expect(buildProvider).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("FALLBACK: null secret → source-verify path (no userinfo fetch for a lost/absent token)", async () => {
    vi.mocked(buildProvider).mockReturnValue(new ResultAsync(Promise.resolve(ok(stubProvider({})))))
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    await verifyCredential(mcpPlatform(), null, FAKE_PATHS, githubOAuthOpts())
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("PRECEDENCE: the oauth2 token check wins over the cli short-circuit (guard runs before kind-dispatch)", async () => {
    // A cli platform can't really hold an oauth2 cred, but pin the ordering:
    // with a userinfo-capable providerId + token, the oauth2 branch fires FIRST,
    // so we never reach the cli "not-verifiable" short-circuit.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    const result = await verifyCredential(cliPlatform(), "tok", FAKE_PATHS, githubOAuthOpts())
    expect(result._unsafeUnwrap()).toEqual({ status: "ok" })
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled()
  })
})
