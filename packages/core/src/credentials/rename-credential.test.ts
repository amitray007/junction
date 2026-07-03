// SPDX-License-Identifier: AGPL-3.0-only
// renameCredential tests.
//
// Coverage:
//   (a) happy path — profileName changes; id/platformId/kind/secretRef stable;
//       the secret still resolves under the SAME secretRef (rename touches no ref).
//   (b) empty/whitespace-only account → typed invalid-input error, no write.
//   (c) trims surrounding whitespace before persisting.
//   (d) unknown credentialId → typed not-found error.
//   (e) oauth-shaped credential (oauthMeta present) — oauthMeta is untouched.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Db } from "../db/index.js"
import { getDatabase } from "../db/index.js"
import { newPlatformId } from "../ids/index.js"
import { ensureHome, getPaths } from "../paths/index.js"
import { createRepositories } from "../repositories/index.js"
import { addCredential } from "./add-credential.js"
import { createEncryptedFileStore } from "./encrypted-file-store.js"
import { resolveMasterKey } from "./master-key.js"
import { renameCredential } from "./rename-credential.js"
import type { CredentialStore } from "./store.js"

describe("renameCredential", () => {
  let db: Db
  let repos: ReturnType<typeof createRepositories>
  let store: CredentialStore
  let home: string
  let prevHome: string | undefined
  let prevStore: string | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    home = await mkdtemp(join(tmpdir(), "junction-rename-test-"))
    process.env.JUNCTION_HOME = home
    process.env.JUNCTION_STORE = "file"

    await ensureHome()
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) throw dbResult.error
    db = dbResult.value
    repos = createRepositories(db)

    const keyResult = await resolveMasterKey(paths, process.env)
    if (keyResult.isErr()) throw keyResult.error
    store = createEncryptedFileStore(paths, keyResult.value)

    await repos.platforms.create({
      id: newPlatformId(),
      kind: "mcp" as const,
      displayName: "Test Platform",
    })
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    await rm(home, { recursive: true, force: true })
  })

  async function getPlatformId(): Promise<string> {
    const list = await repos.platforms.list()
    if (list.isErr()) throw list.error
    const plat = list.value[0]
    if (!plat) throw new Error("No platform seeded")
    return String(plat.id)
  }

  async function seedCredential(account: string, secret = "the-secret"): Promise<string> {
    const platformId = await getPlatformId()
    const platformResult = await repos.platforms.get(platformId)
    if (platformResult.isErr()) throw platformResult.error
    const result = await addCredential(
      { platformId, account, kind: "bearer", secret },
      platformResult.value,
      store,
      repos.credentials,
    )
    if (result.isErr()) throw result.error
    return String(result.value.id)
  }

  it("(a) renames the account label in place, leaving id/platform/kind/secretRef stable + secret resolvable", async () => {
    const id = await seedCredential("work")
    const before = (await repos.credentials.get(id))._unsafeUnwrap()

    const result = await renameCredential(
      { credentialId: id, account: "work-primary" },
      repos.credentials,
    )
    expect(result.isOk()).toBe(true)
    const updated = result._unsafeUnwrap()

    expect(updated.profileName).toBe("work-primary")
    expect(updated.id).toBe(before.id)
    expect(updated.platformId).toBe(before.platformId)
    expect(updated.kind).toBe(before.kind)
    expect(updated.secretRef).toBe(before.secretRef)
    // The secret still resolves under the UNCHANGED secretRef — rename touched no ref.
    const secret = (await store.get(updated.secretRef))._unsafeUnwrap()
    expect(secret).toBe("the-secret")
    // Persisted, not just returned.
    const reread = (await repos.credentials.get(id))._unsafeUnwrap()
    expect(reread.profileName).toBe("work-primary")
  })

  it("(b) rejects an empty account with typed invalid-input and writes nothing", async () => {
    const id = await seedCredential("work")
    const result = await renameCredential({ credentialId: id, account: "   " }, repos.credentials)
    expect(result.isErr()).toBe(true)
    const err = result._unsafeUnwrapErr()
    expect(err.kind).toBe("invalid-input")
    // Unchanged.
    const reread = (await repos.credentials.get(id))._unsafeUnwrap()
    expect(reread.profileName).toBe("work")
  })

  it("(c) trims surrounding whitespace before persisting", async () => {
    const id = await seedCredential("work")
    const result = await renameCredential(
      { credentialId: id, account: "  personal  " },
      repos.credentials,
    )
    expect(result._unsafeUnwrap().profileName).toBe("personal")
  })

  it("(d) unknown credentialId → typed not-found error", async () => {
    const result = await renameCredential(
      { credentialId: "does-not-exist", account: "work" },
      repos.credentials,
    )
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().kind).toBe("not-found")
  })

  it("(e) leaves oauthMeta untouched when renaming an oauth-shaped credential", async () => {
    // Seed an oauth2 credential directly (addCredential excludes oauth2).
    const platformId = await getPlatformId()
    const created = (
      await repos.credentials.create({
        id: `${platformId}-oauth-cred`,
        platformId,
        profileName: "work",
        kind: "oauth2",
        secretRef: "ref-access",
        oauthMeta: {
          providerId: "github",
          refreshTokenRef: "ref-refresh",
          clientIdRef: "ref-client-id",
          clientSecretRef: "ref-client-secret",
          needsReauth: false,
        },
      })
    )._unsafeUnwrap()

    const result = await renameCredential(
      { credentialId: String(created.id), account: "work-renamed" },
      repos.credentials,
    )
    expect(result._unsafeUnwrap().profileName).toBe("work-renamed")

    // Assert oauthMeta preservation from a RE-READ of the persisted row — not the
    // returned object (setProfileName rebuilds its return from the pre-update row,
    // so that alone could pass even if the DB write corrupted oauth_meta). The
    // reread proves the stored oauth_meta is intact + the rename persisted.
    const reread = (await repos.credentials.get(String(created.id)))._unsafeUnwrap()
    expect(reread.profileName).toBe("work-renamed")
    expect(reread.oauthMeta).toEqual(created.oauthMeta)
  })
})
