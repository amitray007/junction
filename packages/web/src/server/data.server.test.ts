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
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  readApps,
  readCredentials,
  readDashboard,
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
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "FAKE_ACCESS_REF_NEVER_EXPOSE",
      oauthMeta: {
        providerId: "github",
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

    expect(cred.oauthState).toEqual({
      providerId: "github",
      expiresAt: "2026-01-01T00:00:00.000Z",
      needsReauth: false,
      // hasRefreshToken is a BOOLEAN derived from refreshTokenRef's presence —
      // true here (the fixture has a refreshTokenRef) — never the ref VALUE.
      hasRefreshToken: true,
    })

    // SECURITY: no ref VALUES anywhere in the serialized credential — only the
    // fields explicitly whitelisted onto oauthState (providerId/expiresAt/
    // needsReauth/hasRefreshToken-as-a-bool). The FAKE_REFRESH_REF value below
    // must be absent even though hasRefreshToken:true is derived from it.
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

    const google = providers.find((p) => p.id === "google")
    expect(google?.supportsDeviceCode).toBe(true)
    expect(google?.redirectMode).toBe("loopback-ephemeral")
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
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "My GitHub MCP" })
    await repos.credentials.create({
      id: newCredentialId(),
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "FAKE_ACCESS_REF_NEVER_EXPOSE",
      oauthMeta: {
        providerId: "github",
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

  it("readApps: metadata only — no secret or secretRef anywhere in the serialized result", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    const repos = createRepositories(dbResult.value)

    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "GitHub" })

    const credId = newCredentialId()
    await repos.credentials.create({
      id: credId,
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "FAKE_ACCESS_REF_NEVER_EXPOSE",
      oauthMeta: {
        providerId: "github",
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
    await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "GitHub" })
    await repos.credentials.create({
      id: newCredentialId(),
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "REF1",
      oauthMeta: { providerId: "github", needsReauth: false },
    })
    await repos.credentials.create({
      id: newCredentialId(),
      platformId,
      profileName: "personal",
      kind: "oauth2",
      secretRef: "REF2",
      oauthMeta: { providerId: "github", needsReauth: false },
    })

    const { groups } = await readApps()
    const github = groups.find((g) => g.appId === "github")
    expect(github?.connections).toHaveLength(2)
    const accounts = github?.connections.map((c) => c.account).sort()
    expect(accounts).toEqual(["personal", "work"])
  })
})
