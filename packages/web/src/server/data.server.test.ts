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
} from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readCredentials, readDashboard, readPlatforms, readProfiles } from "./data.server.js"

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
})
