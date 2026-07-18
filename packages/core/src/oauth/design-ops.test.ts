// SPDX-License-Identifier: AGPL-3.0-only
// design-ops tests (increment 45, Slice D) — add/list/delete authoring ops.
// Covers: create-only + built-in-collision rejection, custom-id-charset
// rejection (delegated to parseCustomOAuthDesign), delete-if-unreferenced
// against BOTH platform.oauthProviderId AND the legacy credential
// oauthMeta.providerId, and built-in delete rejection.

import { describe, expect, it } from "vitest"
import { getDatabase } from "../db/index.js"
import { newCredentialId, newPlatformId } from "../ids/index.js"
import { ensureHome } from "../paths/index.js"
import { createRepositories, type Repositories } from "../repositories/index.js"
import { withTempHome } from "../testing/index.js"
import { addCustomDesign, deleteCustomDesign, listAllDesigns } from "./design-ops.js"
import type { CustomOAuthDesign } from "./designs-store.js"

function makeDesign(overrides: Partial<CustomOAuthDesign> = {}): CustomOAuthDesign {
  return {
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
    ...overrides,
  }
}

async function setupRepos(): Promise<Repositories> {
  const paths = (await ensureHome())._unsafeUnwrap()
  const dbResult = await getDatabase(paths)
  if (dbResult.isErr()) throw new Error(String(dbResult.error))
  return createRepositories(dbResult.value)
}

describe("addCustomDesign", () => {
  it("persists a valid custom design under its custom:<slug> id", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const design = makeDesign()
      const result = await addCustomDesign(paths, design)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) expect(result.value.id).toBe("custom:acme-oauth")

      const listed = await listAllDesigns(paths)
      expect(listed.isOk()).toBe(true)
      if (listed.isOk()) {
        const found = listed.value.find((d) => d.id === "custom:acme-oauth")
        expect(found).toBeDefined()
        expect(found?.isCustom).toBe(true)
      }
    })
  })

  it("rejects an id colliding with a built-in catalog id (builtin-collision)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      // Bypass the schema's custom: prefix requirement isn't possible via
      // parseCustomOAuthDesign (the regex rejects it first) — so this proves
      // the schema-level rejection path, which is the actual defense.
      const design = { ...makeDesign(), id: "github" }
      const result = await addCustomDesign(paths, design)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("invalid-design")
    })
  })

  it("rejects a non-custom:-prefixed id (invalid-design, via schema)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const design = { ...makeDesign(), id: "not-custom-prefixed" }
      const result = await addCustomDesign(paths, design)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("invalid-design")
    })
  })

  it("rejects a duplicate custom id (already-exists, create-only)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const design = makeDesign()
      const first = await addCustomDesign(paths, design)
      expect(first.isOk()).toBe(true)

      const second = await addCustomDesign(paths, design)
      expect(second.isErr()).toBe(true)
      if (second.isErr()) expect(second.error.kind).toBe("already-exists")
    })
  })
})

describe("listAllDesigns", () => {
  it("returns built-ins (isCustom: false) plus any custom designs (isCustom: true)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const before = await listAllDesigns(paths)
      expect(before.isOk()).toBe(true)
      const builtinCount = before.isOk() ? before.value.length : 0
      expect(before.isOk() && before.value.every((d) => !d.isCustom)).toBe(true)

      await addCustomDesign(paths, makeDesign())
      const after = await listAllDesigns(paths)
      expect(after.isOk()).toBe(true)
      if (after.isOk()) {
        expect(after.value.length).toBe(builtinCount + 1)
        const custom = after.value.find((d) => d.id === "custom:acme-oauth")
        expect(custom?.isCustom).toBe(true)
      }
    })
  })
})

describe("deleteCustomDesign", () => {
  it("deletes an unreferenced custom design", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = await setupRepos()
      await addCustomDesign(paths, makeDesign())

      const result = await deleteCustomDesign(paths, repos, "custom:acme-oauth")
      expect(result.isOk()).toBe(true)

      const listed = await listAllDesigns(paths)
      expect(listed.isOk() && listed.value.some((d) => d.id === "custom:acme-oauth")).toBe(false)
    })
  })

  it("refuses to delete a design referenced by a platform's oauthProviderId, naming the referrer", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = await setupRepos()
      await addCustomDesign(paths, makeDesign())

      const platformId = newPlatformId()
      await repos.platforms.create({
        id: platformId,
        kind: "mcp",
        displayName: "Acme via custom design",
        oauthProviderId: "custom:acme-oauth",
      })

      const result = await deleteCustomDesign(paths, repos, "custom:acme-oauth")
      expect(result.isErr()).toBe(true)
      if (result.isErr() && result.error.kind === "referenced") {
        expect(result.error.platformIds).toContain(String(platformId))
        expect(result.error.credentialIds).toEqual([])
      } else {
        throw new Error(`expected "referenced" error, got ${JSON.stringify(result)}`)
      }

      // Still present — the delete never went through.
      const listed = await listAllDesigns(paths)
      expect(listed.isOk() && listed.value.some((d) => d.id === "custom:acme-oauth")).toBe(true)
    })
  })

  // Increment 45, Slice E — `oauthMeta.providerId` no longer exists on a
  // credential (Zod strips it silently), so a credential can no longer
  // reference a design at all — ONLY `platform.oauthProviderId` can. This
  // test used to prove the (now-removed) credential-side referrer check
  // blocked deletion; it now proves the OPPOSITE: an oauth2 credential on a
  // platform with NO `oauthProviderId` set is invisible to the referrer
  // check entirely (`credentialIds` is always `[]`), so deletion succeeds.
  it("increment 45 Slice E: a credential can no longer reference a design — only the bound PLATFORM's oauthProviderId blocks deletion", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = await setupRepos()
      await addCustomDesign(paths, makeDesign())

      const platformId = newPlatformId()
      // Platform has NO oauthProviderId set — nothing binds it to the design.
      await repos.platforms.create({ id: platformId, kind: "mcp", displayName: "No design ref" })
      const credentialId = newCredentialId()
      await repos.credentials.create({
        id: credentialId,
        name: "legacy-cred",
        platformId,
        profileName: "work",
        kind: "oauth2",
        secretRef: "FAKE_REF_NEVER_EXPOSE",
        oauthMeta: {
          expiresAt: null,
          needsReauth: false,
        },
      })

      // Unreferenced (per the platform-only check) → deletion succeeds.
      const result = await deleteCustomDesign(paths, repos, "custom:acme-oauth")
      expect(result.isOk()).toBe(true)
    })
  })

  it("refuses to delete a design referenced by a platform's oauthProviderId", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = await setupRepos()
      await addCustomDesign(paths, makeDesign())

      const platformId = newPlatformId()
      await repos.platforms.create({
        id: platformId,
        kind: "mcp",
        displayName: "Bound",
        oauthProviderId: "custom:acme-oauth",
      })

      const result = await deleteCustomDesign(paths, repos, "custom:acme-oauth")
      expect(result.isErr()).toBe(true)
      if (result.isErr() && result.error.kind === "referenced") {
        expect(result.error.platformIds).toContain(String(platformId))
        expect(result.error.credentialIds).toEqual([])
      } else {
        throw new Error(`expected "referenced" error, got ${JSON.stringify(result)}`)
      }
    })
  })

  it("refuses to delete a built-in id (not-custom, not a 404)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = await setupRepos()
      const result = await deleteCustomDesign(paths, repos, "github")
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("not-custom")
    })
  })

  it("returns not-found for a well-formed custom: id that was never created", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = await setupRepos()
      const result = await deleteCustomDesign(paths, repos, "custom:never-existed")
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("not-found")
    })
  })
})
