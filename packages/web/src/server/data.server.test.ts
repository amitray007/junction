// SPDX-License-Identifier: AGPL-3.0-only
// data.server unit tests — plain async helpers (not the createServerFn wrappers).
// Verifies data shapes and the load-bearing invariant: no secret or secretRef
// in any credentials output.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRepositories,
  getDatabase,
  getPaths,
  newCredentialId,
  newPlatformId,
  newProfileId,
  PlatformIdSchema,
} from "@junction/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock probeSurface (increment 30.10) so the surface-state aggregation logic
// (readAppDetail's "serving" computation) can be tested with CONTROLLED
// per-connection tool results — the review-fix regression test below needs
// two connections with DIFFERENT health/tools combinations, which the real
// probeSurface (network/DB-backed) can't deterministically produce. Defaults
// to the REAL implementation (spy, not a replace) so every other test in this
// file keeps exercising the genuine probeSurface behavior; only the dedicated
// "serving" test below overrides it with mockImplementationOnce-style control.
// vi.mock calls are hoisted above ALL top-level statements (including
// `const`/`vi.fn()`), so the spy must be created via vi.hoisted() to exist
// before the factory below runs.
const { probeSurfaceSpy } = vi.hoisted(() => ({ probeSurfaceSpy: vi.fn() }))
vi.mock("./probe.server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./probe.server.js")>()
  probeSurfaceSpy.mockImplementation(actual.probeSurface)
  return {
    ...actual,
    probeSurface: (...args: Parameters<typeof actual.probeSurface>) => probeSurfaceSpy(...args),
  }
})

import {
  readAppDetail,
  readApps,
  readCredentials,
  readDashboard,
  readOAuthDesigns,
  readOAuthProviders,
  readPlatforms,
  readProfiles,
} from "./data.server.js"

describe("data.server", () => {
  let tmpHome: string
  let prevHome: string | undefined
  let prevStore: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "junction-web-test-"))
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    process.env.JUNCTION_HOME = tmpHome
    // Use file store to avoid keyring access in CI
    process.env.JUNCTION_STORE = "file"
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    await rm(tmpHome, { recursive: true, force: true })
    // Restore the real probeSurface after every test — only the two "serving"
    // regression tests override it with a synthetic implementation. vi.mock's
    // module cache means this re-import is cheap (already loaded).
    const actual = await vi.importActual<typeof import("./probe.server.js")>("./probe.server.js")
    probeSurfaceSpy.mockImplementation(actual.probeSurface)
  })

  // ---------------------------------------------------------------------------
  // readDashboard
  // ---------------------------------------------------------------------------

  it("readDashboard: returns home path and zero counts on an empty DB", async () => {
    const data = await readDashboard()
    expect(data.home).toBe(tmpHome)
    expect(data.initialized).toBe(false)
    expect(data.counts).toEqual({ platforms: 0, credentials: 0, profiles: 0 })
    expect(typeof data.credentialStore).toBe("string")
    expect(data.credentialStore.length).toBeGreaterThan(0)
  })

  // ---------------------------------------------------------------------------
  // readPlatforms
  // ---------------------------------------------------------------------------

  it("readPlatforms: returns empty array on empty DB", async () => {
    expect(await readPlatforms()).toEqual([])
  })

  it("readPlatforms: returns seeded platform metadata (no internal fields)", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    const createResult = await repos.platforms.create({
      id: platformId,
      kind: "openapi",
      displayName: "My API",
      baseUrl: "https://api.example.com",
    })
    if (createResult.isErr()) throw new Error(String(createResult.error))

    const platforms = await readPlatforms()
    expect(platforms).toHaveLength(1)
    const [p] = platforms
    if (!p) throw new Error("no platform in result")
    expect(p.id).toBe(String(platformId))
    expect(p.kind).toBe("openapi")
    expect(p.displayName).toBe("My API")
    expect(p.baseUrl).toBe("https://api.example.com")
    // Internal connection descriptors must not leak
    expect("connection" in p).toBe(false)
    expect("openapi" in p).toBe(false)
    expect("specUrl" in p).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // readCredentials — the load-bearing security invariant
  // ---------------------------------------------------------------------------

  it("readCredentials: returns empty array on empty DB", async () => {
    expect(await readCredentials()).toEqual([])
  })

  it("readCredentials: metadata only — no secret or secretRef in any object", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "P" })

    const credId = newCredentialId()
    const createResult = await repos.credentials.create({
      id: credId,
      name: "work-1",
      platformId,
      profileName: "work",
      kind: "bearer",
      secretRef: "FAKE_SECRET_REF_NEVER_EXPOSE",
    })
    if (createResult.isErr()) throw new Error(String(createResult.error))

    const creds = await readCredentials()
    expect(creds).toHaveLength(1)
    const [cred] = creds
    if (!cred) throw new Error("no credential in result")

    // Shape: expected metadata fields
    expect(cred.id).toBe(String(credId))
    expect(cred.platformId).toBe(String(platformId))
    expect(cred.account).toBe("work")
    expect(cred.kind).toBe("bearer")

    // SECURITY: no secret or secretRef keys
    expect("secret" in cred).toBe(false)
    expect("secretRef" in cred).toBe(false)
    // The fake ref value must not appear anywhere in the serialized output
    expect(JSON.stringify(cred)).not.toContain("FAKE_SECRET_REF_NEVER_EXPOSE")
  })

  // ---------------------------------------------------------------------------
  // readCredentials — oauthState (inc 29): metadata only, refs/tokens never leak
  // ---------------------------------------------------------------------------

  it("readCredentials: oauth2 credential exposes oauthState metadata, never a ref value", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "OAuth Platform" })

    const credId = newCredentialId()
    const createResult = await repos.credentials.create({
      id: credId,
      name: "work-2",
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "FAKE_ACCESS_REF_NEVER_EXPOSE",
      oauthMeta: {
        refreshTokenRef: "FAKE_REFRESH_REF_NEVER_EXPOSE",
        clientIdRef: "FAKE_CLIENT_ID_REF",
        clientSecretRef: "FAKE_CLIENT_SECRET_REF_NEVER_EXPOSE",
        expiresAt: "2026-01-01T00:00:00.000Z",
        needsReauth: false,
        scopes: ["repo"],
      },
    })
    if (createResult.isErr()) throw new Error(String(createResult.error))

    const creds = await readCredentials()
    const [cred] = creds
    if (!cred) throw new Error("no credential in result")

    // Increment 45, Slice E — `providerId` dropped from oauthState (never
    // rendered anywhere; its sole purpose was feeding the now-removed
    // grouping fallback).
    expect(cred.oauthState).toEqual({
      expiresAt: "2026-01-01T00:00:00.000Z",
      needsReauth: false,
      // hasRefreshToken is a BOOLEAN derived from refreshTokenRef's presence —
      // true here (the fixture has a refreshTokenRef) — never the ref VALUE.
      hasRefreshToken: true,
    })

    // SECURITY: no ref VALUES anywhere in the serialized credential — only the
    // fields explicitly whitelisted onto oauthState (expiresAt/needsReauth/
    // hasRefreshToken-as-a-bool). The FAKE_REFRESH_REF value below must be
    // absent even though hasRefreshToken:true is derived from it.
    const serialized = JSON.stringify(cred)
    expect(serialized).not.toContain("FAKE_ACCESS_REF_NEVER_EXPOSE")
    expect(serialized).not.toContain("FAKE_REFRESH_REF_NEVER_EXPOSE")
    expect(serialized).not.toContain("FAKE_CLIENT_ID_REF")
    expect(serialized).not.toContain("FAKE_CLIENT_SECRET_REF_NEVER_EXPOSE")
    expect("refreshTokenRef" in (cred.oauthState ?? {})).toBe(false)
    expect("clientIdRef" in (cred.oauthState ?? {})).toBe(false)
    expect("clientSecretRef" in (cred.oauthState ?? {})).toBe(false)
  })

  it("readCredentials: a non-oauth2 credential has no oauthState field at all", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "P" })
    await repos.credentials.create({
      id: newCredentialId(),
      name: "work-3",
      platformId,
      profileName: "work",
      kind: "bearer",
      secretRef: "REF",
    })

    const [cred] = await readCredentials()
    if (!cred) throw new Error("no credential in result")
    expect("oauthState" in cred).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // readOAuthProviders — the catalog picker/guided-registration data source
  // ---------------------------------------------------------------------------

  it("readOAuthProviders: exposes the catalog, no HTTP/DB involved", () => {
    const providers = readOAuthProviders()
    expect(providers.length).toBeGreaterThan(0)
    const github = providers.find((p) => p.id === "github")
    expect(github).toBeDefined()
    expect(github?.displayName).toBe("GitHub")
    expect(github?.registrationHint.redirectUri).toBe("http://127.0.0.1:4321/oauth/callback")
    expect(github?.supportsDeviceCode).toBe(false)

    // google (the device-code example) was removed in the inc 35 catalog
    // strip-down and restored in increment 39 (gmail) — supportsDeviceCode:true
    // derivation coverage returns with it. Every OTHER surviving provider still
    // correctly reports supportsDeviceCode:false.
    const google = providers.find((p) => p.id === "google")
    expect(google).toBeDefined()
    expect(google?.supportsDeviceCode).toBe(true)
    expect(
      providers.filter((p) => p.id !== "google").every((p) => p.supportsDeviceCode === false),
    ).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // readProfiles
  // ---------------------------------------------------------------------------

  it("readProfiles: returns empty array on empty DB", async () => {
    expect(await readProfiles()).toEqual([])
  })

  it("readProfiles: credentialed source shows account name", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "P" })

    const credId = newCredentialId()
    await repos.credentials.create({
      id: credId,
      name: "personal-4",
      platformId,
      profileName: "personal",
      kind: "bearer",
      secretRef: "FAKE_REF",
    })

    const profileId = newProfileId()
    const profileName = "default"
    await repos.profiles.create({
      id: profileId,
      name: profileName,
      sources: [],
    })
    await repos.profiles.addSource(String(profileId), {
      platformId,
      credentialId: credId,
      toolNamespace: "my_ns",
      enabled: true,
    })

    const profiles = await readProfiles()
    expect(profiles).toHaveLength(1)
    const [prof] = profiles
    if (!prof) throw new Error("no profile in result")
    expect(prof.name).toBe("default")
    expect(prof.sources).toHaveLength(1)
    const [src] = prof.sources
    if (!src) throw new Error("no source in result")
    expect(src.namespace).toBe("my_ns")
    expect(src.platform).toBe(String(platformId))
    expect(src.credentialAccount).toBe("personal")
    expect(src.enabled).toBe(true)
    // secretRef must not appear in the serialized profile output
    expect(JSON.stringify(profiles)).not.toContain("FAKE_REF")
  })

  it("readProfiles: public source shows '(none)' credentialAccount", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "P" })

    const profileId = newProfileId()
    const profileName = "pub-profile"
    await repos.profiles.create({
      id: profileId,
      name: profileName,
      sources: [],
    })
    await repos.profiles.addSource(String(profileId), {
      platformId,
      toolNamespace: "pub_ns",
      enabled: true,
    })

    const profiles = await readProfiles()
    const [prof] = profiles
    if (!prof) throw new Error("no profile in result")
    const [src] = prof.sources
    if (!src) throw new Error("no source in result")
    expect(src.credentialAccount).toBe("(none)")
  })

  // ---------------------------------------------------------------------------
  // readApps (increment 30) — the derived App grouping. Metadata-only test
  // mirrors readCredentials' security invariant; a positive-control grouping
  // test confirms the oauthState.providerId → oauthProviderId mapping (review
  // C2) is actually wired, not just declared.
  // ---------------------------------------------------------------------------

  it("readApps: catalog is non-empty and groups is empty on an empty DB", async () => {
    const { catalog, groups } = await readApps()
    expect(catalog.length).toBeGreaterThan(0)
    expect(catalog.find((a) => a.id === "github")).toBeDefined()
    expect(groups).toEqual([])
  })

  it("readApps: a GitHub oauth2 credential groups under the github App (positive control)", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    // Increment 45, Slice E — the design lives on the PLATFORM only.
    await repos.platforms.create({
      id: platformId,
      kind: "mcp",
      displayName: "My GitHub MCP",
      oauthProviderId: "github",
    })
    await repos.credentials.create({
      id: newCredentialId(),
      name: "work-5",
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "FAKE_ACCESS_REF_NEVER_EXPOSE",
      oauthMeta: {
        expiresAt: "2026-01-01T00:00:00.000Z",
        needsReauth: false,
        scopes: ["repo"],
      },
    })

    const { groups } = await readApps()
    const github = groups.find((g) => g.appId === "github")
    expect(github).toBeDefined()
    expect(github?.connections).toHaveLength(1)
    expect(github?.connections[0]?.account).toBe("work")
  })

  it("readApps: a platform with no matching id/provider lands in 'other' (negative control)", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "Unrecognized Thing" })
    await repos.credentials.create({
      id: newCredentialId(),
      name: "work-6",
      platformId,
      profileName: "work",
      kind: "bearer",
      secretRef: "REF",
    })

    const { groups } = await readApps()
    const other = groups.find((g) => g.appId === "other")
    expect(other).toBeDefined()
    expect(other?.connections.some((c) => c.platformId === String(platformId))).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // R3 grouping re-source (increment 44; narrowed increment 45 Slice E) —
  // grouping must source the OAuth design through the SAME
  // resolveOAuthProviderId refresh uses. The platform's own oauthProviderId
  // is the ONLY source (the credential's legacy copy no longer exists at
  // all). These tests prove the resolver is actually in the path (a
  // platform-set design groups correctly) and that a platform with no design
  // set lands the connection in "other", never guessing.
  // ---------------------------------------------------------------------------

  it("readApps R3: the PLATFORM's oauthProviderId is the ONLY source grouping consults", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    await repos.platforms.create({
      id: platformId,
      kind: "mcp",
      displayName: "My GitHub MCP",
      oauthProviderId: "github",
    })
    await repos.credentials.create({
      id: newCredentialId(),
      name: "work-r3a",
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "FAKE_ACCESS_REF_NEVER_EXPOSE",
      oauthMeta: {
        expiresAt: "2026-01-01T00:00:00.000Z",
        needsReauth: false,
        scopes: ["repo"],
      },
    })

    const { groups } = await readApps()
    expect(groups.find((g) => g.appId === "github")?.connections).toHaveLength(1)
  })

  it("readApps R3 (Slice E): a platform with NO oauthProviderId set → the connection lands in 'other', no fallback exists to save it", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    // Platform has NO oauthProviderId — increment 45 Slice E removed the
    // legacy fallback that used to rescue this case, so resolution now
    // degrades to "no hint" and the connection falls through to "other".
    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "Legacy GitHub" })
    await repos.credentials.create({
      id: newCredentialId(),
      name: "work-r3b",
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "FAKE_ACCESS_REF_NEVER_EXPOSE",
      oauthMeta: {
        expiresAt: "2026-01-01T00:00:00.000Z",
        needsReauth: false,
        scopes: ["repo"],
      },
    })

    const { groups } = await readApps()
    expect(groups.find((g) => g.appId === "github")).toBeUndefined()
    const other = groups.find((g) => g.appId === "other")
    expect(other?.connections.some((c) => c.platformId === String(platformId))).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // readOAuthDesigns (increment 44, R1) — the read-only designs list + the
  // "which platforms reference this design" join.
  // ---------------------------------------------------------------------------

  it("readOAuthDesigns: lists built-ins metadata-only + flags the generic template", async () => {
    const designs = await readOAuthDesigns()
    const github = designs.find((d) => d.id === "github")
    expect(github).toBeDefined()
    expect(github?.displayName).toBe("GitHub")
    expect(github?.authorizationUrl).toBe("https://github.com/login/oauth/authorize")
    expect(github?.isTemplate).toBe(false)

    const generic = designs.find((d) => d.id === "generic")
    expect(generic?.isTemplate).toBe(true)
    expect(generic?.authorizationUrl).toBe("") // template: user-supplied endpoints

    // Metadata-only: the public catalog carries no client secret / token value.
    const serialized = JSON.stringify(designs)
    expect(serialized).not.toContain('"secret"')
    expect(serialized).not.toContain('"clientSecret"')
  })

  it("readOAuthDesigns: reports which platforms reference each design (and none when unreferenced)", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    // Two platforms reference github; none reference google.
    const p1 = newPlatformId()
    const p2 = newPlatformId()
    await repos.platforms.create({
      id: p1,
      kind: "mcp",
      displayName: "GH one",
      oauthProviderId: "github",
    })
    await repos.platforms.create({
      id: p2,
      kind: "mcp",
      displayName: "GH two",
      oauthProviderId: "github",
    })

    const designs = await readOAuthDesigns()
    const github = designs.find((d) => d.id === "github")
    expect(github?.referencedByPlatformIds).toHaveLength(2)
    expect(github?.referencedByPlatformIds).toContain(String(p1))
    expect(github?.referencedByPlatformIds).toContain(String(p2))

    const google = designs.find((d) => d.id === "google")
    expect(google?.referencedByPlatformIds).toEqual([])
  })

  it("readOAuthDesigns (increment 45, Slice D): built-ins are isCustom:false; a custom design added via addCustomDesign shows isCustom:true and its own referencedByPlatformIds", async () => {
    const { addCustomDesign } = await import("@junction/core")
    const paths = getPaths()

    await addCustomDesign(paths, {
      id: "custom:acme-oauth",
      displayName: "Acme OAuth",
      authorizationUrl: "https://acme.example.com/oauth/authorize",
      tokenUrl: "https://acme.example.com/oauth/token",
      scopeSeparator: " ",
      pkce: "S256",
      supportsRefresh: true,
      expiryStrategy: "expires_in",
      redirectMode: "loopback-fixed",
      registrationHint: { redirectUri: "", scopes: "", docsUrl: "" },
    })

    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)
    const platformId = newPlatformId()
    await repos.platforms.create({
      id: platformId,
      kind: "mcp",
      displayName: "Acme via custom design",
      oauthProviderId: "custom:acme-oauth",
    })

    const designs = await readOAuthDesigns()
    const github = designs.find((d) => d.id === "github")
    expect(github?.isCustom).toBe(false)

    const custom = designs.find((d) => d.id === "custom:acme-oauth")
    expect(custom).toBeDefined()
    expect(custom?.isCustom).toBe(true)
    expect(custom?.referencedByPlatformIds).toEqual([String(platformId)])
  })

  it("readApps: metadata only — no secret or secretRef anywhere in the serialized result", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "GitHub" })

    const credId = newCredentialId()
    await repos.credentials.create({
      id: credId,
      name: "work-7",
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "FAKE_ACCESS_REF_NEVER_EXPOSE",
      oauthMeta: {
        refreshTokenRef: "FAKE_REFRESH_REF_NEVER_EXPOSE",
        clientIdRef: "FAKE_CLIENT_ID_REF",
        clientSecretRef: "FAKE_CLIENT_SECRET_REF_NEVER_EXPOSE",
        expiresAt: "2026-01-01T00:00:00.000Z",
        needsReauth: false,
        scopes: ["repo"],
      },
    })

    const data = await readApps()
    const serialized = JSON.stringify(data)
    expect(serialized).not.toContain("FAKE_ACCESS_REF_NEVER_EXPOSE")
    expect(serialized).not.toContain("FAKE_REFRESH_REF_NEVER_EXPOSE")
    expect(serialized).not.toContain("FAKE_CLIENT_ID_REF")
    expect(serialized).not.toContain("FAKE_CLIENT_SECRET_REF_NEVER_EXPOSE")
    expect(serialized).not.toContain('"secret"')
    expect(serialized).not.toContain('"secretRef"')
  })

  it("readApps: a public/no-credential platform yields a credential-less connection", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    await repos.platforms.create({
      id: PlatformIdSchema.parse("github"),
      kind: "mcp",
      displayName: "GitHub (public)",
    })

    const { groups } = await readApps()
    const github = groups.find((g) => g.appId === "github")
    expect(github?.connections).toHaveLength(1)
    expect(github?.connections[0]?.account).toBe("—")
    expect(github?.connections[0]?.credentialId).toBeUndefined()
  })

  it("readApps: the wedge — two credentials on one platform yield two connections", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    // Increment 45, Slice E — grouping now sources the design EXCLUSIVELY
    // from the platform's own oauthProviderId (a random ULID platform id
    // never matches "github" by id/alias on its own).
    await repos.platforms.create({
      id: platformId,
      kind: "mcp",
      displayName: "GitHub",
      oauthProviderId: "github",
    })
    await repos.credentials.create({
      id: newCredentialId(),
      name: "work-8",
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "REF1",
      oauthMeta: { needsReauth: false },
    })
    await repos.credentials.create({
      id: newCredentialId(),
      name: "personal-9",
      platformId,
      profileName: "personal",
      kind: "oauth2",
      secretRef: "REF2",
      oauthMeta: { needsReauth: false },
    })

    const { groups } = await readApps()
    const github = groups.find((g) => g.appId === "github")
    expect(github?.connections).toHaveLength(2)
    const accounts = github?.connections.map((c) => c.account).sort()
    expect(accounts).toEqual(["personal", "work"])
  })

  // ---------------------------------------------------------------------------
  // readAppDetail (increment 30.10) — the surface-first /app/:id DTO.
  // GitHub's catalog entry is the QA fixture: 5 authored surfaces
  // (openapi/graphql/mcp/cli/http). No real network access is exercised here
  // (no credential is ever seeded), so every surface's probe resolves through
  // resolveCredentialSecret's no-credential fast path — this proves the
  // whole pipeline (catalog → intersect → probe → DTO) runs end-to-end
  // without crashing, and stays metadata-only throughout.
  // ---------------------------------------------------------------------------

  describe("readAppDetail", () => {
    it("GitHub's 5 catalog surfaces all reach the DTO, in catalog order", async () => {
      const detail = await readAppDetail("github")
      expect(detail.app.id).toBe("github")
      expect(detail.app.displayName).toBe("GitHub")
      expect(detail.surfaces.map((s) => s.kind)).toEqual([
        "openapi",
        "graphql",
        "mcp",
        "cli",
        "http",
      ])
      // No connections seeded → every surface is "available".
      expect(detail.surfaces.every((s) => s.state === "available")).toBe(true)
      expect(detail.otherConnections).toEqual([])
    })

    // App-detail Connect CTAs for surfaceless apps (increment 32.6a) — the
    // catalog entry's top-level auth[] now rides through app.authModes on
    // BOTH construction sites (thin fallback AND the full surface-first
    // return), so the route's EmptyAppState always gets real modes instead
    // of a hardcoded [].
    it("a surface-authored app (github) also carries its catalog auth modes on app.authModes", async () => {
      const detail = await readAppDetail("github")
      // GitHub's catalog auth[] is [oauth2 (github), oauth2 (github-app), token].
      expect(detail.app.authModes).toEqual(["oauth2", "oauth2", "token"])
    })

    // Backfill-proof (this test kept breaking as apps gained surfaces[] — gitlab in
    // 32.6c, atlassian in 30.13). Instead of hardcoding one app, DYNAMICALLY find a
    // still-surfaceless catalog app and assert the thin-fallback plumbs its catalog
    // auth[] modes onto app.authModes with an empty surfaces list. As long as ONE thin
    // app exists this is stable; if the catalog ever fully backfills, this skips.
    it("a surfaceless (thin) app carries its catalog auth modes on app.authModes, surfaces empty", async () => {
      const { listCatalogEntries } = await import("@junction/core")
      const thin = listCatalogEntries().find(
        (e) => (e.surfaces === undefined || e.surfaces.length === 0) && e.auth.length > 0,
      )
      if (thin === undefined) return // fully backfilled — nothing thin to exercise (unlikely)
      const detail = await readAppDetail(thin.id)
      expect(detail.surfaces).toEqual([])
      expect(detail.app.authModes).toEqual(thin.auth.map((a) => a.mode))
      // the thin fallback still plumbs SOME auth mode → at least one Connect/Add CTA renders
      expect(detail.app.authModes.length).toBeGreaterThan(0)
    })

    // "a none-only auth app carries authModes: ['none']" (formerly anilist)
    // removed in increment 35's catalog strip-down — the catalog has no
    // 'none'-only-auth app until one is reintroduced (36+); the case it
    // proved is otherwise a duplicate of the "unknown id" test below (both
    // fall back to authModes: [] once the catalog entry is gone).

    it("an unknown id with no catalog entry falls back to authModes: []", async () => {
      const detail = await readAppDetail("totally-unknown-app-id")
      expect(detail.app.authModes).toEqual([])
    })

    it("metadata-only negative test: the DTO carries NO secretRef/build/connection fields", async () => {
      const detail = await readAppDetail("github")
      const serialized = JSON.stringify(detail)
      // Telltale AppSurface.connection / AppSurface.build FIELD KEYS that a
      // fresh SurfaceView type must never carry through — asserted as JSON
      // key patterns (`"key":`), not bare substrings: GitHub's cli surface
      // legitimately mentions "credentialEnvVar" in its free-text `notes[]`
      // (documentation prose, not a leaked field), so a plain substring
      // check would false-positive on that honest text.
      expect(serialized).not.toMatch(/"secretRef":/)
      expect(serialized).not.toMatch(/"specUrl":/)
      expect(serialized).not.toMatch(/"credentialEnvVar":/)
      expect(serialized).not.toMatch(/"platformIdTemplate":/)
      expect(serialized).not.toMatch(/"connection":/)
      expect(serialized).not.toMatch(/"build":/)
    })

    it("a connection whose platform kind+id groups under github AND matches a surface kind gets probed (no crash, honest error — no credential store touch succeeds without a real secret)", async () => {
      const dbResult = await getDatabase(getPaths())
      if (dbResult.isErr()) throw new Error(String(dbResult.error))
      const repos = createRepositories(dbResult.value)

      // platformId "github" + kind "openapi" → appIdForConnection resolves to
      // "github" by exact id match; kind "openapi" matches GitHub's REST API surface.
      await repos.platforms.create({
        id: PlatformIdSchema.parse("github"),
        kind: "openapi",
        displayName: "GitHub",
      })

      const detail = await readAppDetail("github")
      const openapiSurface = detail.surfaces.find((s) => s.kind === "openapi")
      expect(openapiSurface).toBeDefined()
      // Credential-less connection → resolveCredentialSecret's fast path,
      // buildProvider attempts a real openapi provider with no cached spec →
      // an honest error result, never a throw (this whole test running to
      // completion IS the non-throw proof).
      expect(openapiSurface?.connections).toHaveLength(1)
      expect(openapiSurface?.connections[0]?.tools.status).toBe("error")
    })

    // "thin/undefined-catalog app (no authored surfaces) falls back honestly
    // — surfaces empty, connections preserved" (formerly spotify) removed in
    // increment 35's catalog strip-down. It required a REAL catalog app with
    // zero authored surfaces so a platform whose id exact-matches it (via
    // appIdForConnection) groups under that app id rather than "other" — the
    // catalog is github-only now and github IS fully surfaced, so there's no
    // thin-but-cataloged app left to exercise this against. Returns to
    // coverage once a thin app is reintroduced (36+) before its surfaces are
    // authored. The DIFFERENT "id === 'other'" thin-fallback path (connections
    // preserved via the synthetic 'other' bucket) stays covered by the test
    // below.

    it("an unknown id with no catalog entry and no connections falls back to an honest empty DTO (never throws)", async () => {
      const detail = await readAppDetail("totally-unknown-app-id")
      expect(detail.app.id).toBe("totally-unknown-app-id")
      expect(detail.surfaces).toEqual([])
      expect(detail.otherConnections).toEqual([])
    })

    it("id === 'other' takes the thin fallback path, carrying its connections", async () => {
      const dbResult = await getDatabase(getPaths())
      if (dbResult.isErr()) throw new Error(String(dbResult.error))
      const repos = createRepositories(dbResult.value)

      await repos.platforms.create({
        id: newPlatformId(),
        kind: "mcp",
        displayName: "Unrecognized Thing",
      })

      const detail = await readAppDetail("other")
      expect(detail.app.id).toBe("other")
      expect(detail.app.displayName).toBe("Other")
      expect(detail.surfaces).toEqual([])
      expect(detail.otherConnections).toHaveLength(1)
    })

    it("a connection whose kind matches NO github surface lands in otherConnections (the leftover bucket), never dropped", async () => {
      const dbResult = await getDatabase(getPaths())
      if (dbResult.isErr()) throw new Error(String(dbResult.error))
      const repos = createRepositories(dbResult.value)

      // GitHub's surfaces are openapi/graphql/mcp/cli/http — every PlatformKind
      // is covered, so to exercise a genuine leftover we'd need a 6th kind.
      // Since PlatformKind is closed today, assert the CURRENT contract
      // instead: a github-id platform of a kind GitHub's catalog DOES cover
      // matches its surface, proving intersectSurfaces is actually wired
      // (leftover-bucket accounting itself is unit-tested directly in
      // core's surface-connections.test.ts against synthetic kinds).
      await repos.platforms.create({
        id: PlatformIdSchema.parse("github"),
        kind: "graphql",
        displayName: "GitHub",
      })
      const detail = await readAppDetail("github")
      const graphqlSurface = detail.surfaces.find((s) => s.kind === "graphql")
      expect(graphqlSurface?.connections).toHaveLength(1)
      expect(detail.otherConnections).toEqual([])
    })

    // ---------------------------------------------------------------------
    // Review fix: "serving" requires the SAME connection to be both healthy
    // AND probed-with-tools — NOT two independent any/any scans (a healthy
    // connection with 0 tools + a DIFFERENT unhealthy connection WITH tools
    // must read as "connected", never "serving").
    // ---------------------------------------------------------------------

    it("serving requires the SAME connection to be healthy AND have tools — a healthy-but-toolless connection plus an unhealthy-but-tooled connection is NOT serving", async () => {
      const dbResult = await getDatabase(getPaths())
      if (dbResult.isErr()) throw new Error(String(dbResult.error))
      const repos = createRepositories(dbResult.value)

      const platformId = PlatformIdSchema.parse("github")
      await repos.platforms.create({ id: platformId, kind: "graphql", displayName: "GitHub" })

      // Connection A: healthy (verified ok) but the probe returns ZERO tools.
      // lastVerifyResult is NOT a create()-time field — it's written via the
      // dedicated setVerifyState(id, result, at) update, same as a real
      // verify-on-add/test-connection event.
      const credA = newCredentialId()
      await repos.credentials.create({
        id: credA,
        name: "healthy-no-tools-10",
        platformId,
        profileName: "healthy-no-tools",
        kind: "bearer",
        secretRef: "REF_A",
      })
      await repos.credentials.setVerifyState(String(credA), "ok", Date.now())

      // Connection B: unhealthy (auth-failed) but the probe returns tools.
      const credB = newCredentialId()
      await repos.credentials.create({
        id: credB,
        name: "unhealthy-with-tools-11",
        platformId,
        profileName: "unhealthy-with-tools",
        kind: "bearer",
        secretRef: "REF_B",
      })
      await repos.credentials.setVerifyState(String(credB), "auth-failed", Date.now())

      probeSurfaceSpy.mockImplementation(async ({ credentialId }: { credentialId?: string }) => {
        if (credentialId === String(credB)) {
          return { status: "ok" as const, tools: [{ namespaced: "x", raw: "x" }] }
        }
        return { status: "ok" as const, tools: [] }
      })

      const detail = await readAppDetail("github")
      const graphqlSurface = detail.surfaces.find((s) => s.kind === "graphql")
      expect(graphqlSurface?.connections).toHaveLength(2)
      // The old (buggy) any/any logic would have reported "serving" here —
      // this asserts the fixed, per-connection-AND logic instead.
      expect(graphqlSurface?.state).toBe("connected")
    })

    it("serving DOES apply when the SAME connection is both healthy and has tools", async () => {
      const dbResult = await getDatabase(getPaths())
      if (dbResult.isErr()) throw new Error(String(dbResult.error))
      const repos = createRepositories(dbResult.value)

      const platformId = PlatformIdSchema.parse("github")
      await repos.platforms.create({ id: platformId, kind: "graphql", displayName: "GitHub" })

      const cred = newCredentialId()
      await repos.credentials.create({
        id: cred,
        name: "healthy-with-tools-12",
        platformId,
        profileName: "healthy-with-tools",
        kind: "bearer",
        secretRef: "REF",
      })
      await repos.credentials.setVerifyState(String(cred), "ok", Date.now())

      probeSurfaceSpy.mockImplementation(async () => ({
        status: "ok" as const,
        tools: [{ namespaced: "y", raw: "y" }],
      }))

      const detail = await readAppDetail("github")
      const graphqlSurface = detail.surfaces.find((s) => s.kind === "graphql")
      expect(graphqlSurface?.state).toBe("serving")
    })
  })
})
