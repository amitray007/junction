// SPDX-License-Identifier: AGPL-3.0-only
// resolveCredentialProviderId tests (increment 45, Slice C; narrowed Slice E —
// the legacy `oauthMeta.providerId` fallback is GONE) — the shared
// load-designs → merge → fetch-platform → resolve → degrade helper every
// live display/verify-hint/reconnect reader goes through instead of reading
// `credential.oauthMeta.providerId` directly (that field no longer exists).

import { errAsync, okAsync } from "neverthrow"
import { describe, expect, it, vi } from "vitest"
import { ensureHome } from "../paths/index.js"
import type { Repositories } from "../repositories/index.js"
import type { Credential } from "../schema/credential.js"
import type { Platform } from "../schema/platform.js"
import { withTempHome } from "../testing/index.js"
import { saveCustomDesigns } from "./designs-store.js"
import { resolveCredentialProviderId } from "./resolve-credential-provider-id.js"

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred_1",
    name: "cred-1",
    platformId: "plat_1",
    profileName: "cred-1",
    kind: "oauth2",
    secretRef: "ref_secret",
    ...overrides,
  }
}

function makePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    id: "plat_1",
    kind: "http",
    displayName: "Test Platform",
    ...overrides,
  } as Platform
}

function reposWithPlatform(platform: Platform | undefined): Pick<Repositories, "platforms"> {
  return {
    platforms: {
      get: vi.fn(() =>
        platform !== undefined
          ? okAsync(platform)
          : errAsync({ kind: "not-found", entity: "platform", id: "plat_1" }),
      ),
    },
  } as unknown as Pick<Repositories, "platforms">
}

describe("resolveCredentialProviderId", () => {
  it("platform.oauthProviderId set → resolves via the platform's design", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = reposWithPlatform(makePlatform({ oauthProviderId: "github" }))
      const credential = makeCredential()

      const providerId = await resolveCredentialProviderId({
        repos,
        paths,
        credential,
        context: "group",
      })

      expect(providerId).toBe("github")
    })
  })

  it("increment 45 Slice E: platform has no oauthProviderId set → degrades to undefined (no legacy fallback exists anymore)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = reposWithPlatform(makePlatform())
      const credential = makeCredential()

      const providerId = await resolveCredentialProviderId({
        repos,
        paths,
        credential,
        context: "refresh",
      })

      expect(providerId).toBeUndefined()
    })
  })

  it("a custom:<slug> platform reference resolves through the merged designs set", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const design = {
        id: "custom:acme-oauth",
        displayName: "Acme OAuth",
        authorizationUrl: "https://acme.example.com/oauth/authorize",
        tokenUrl: "https://acme.example.com/oauth/token",
        scopeSeparator: " " as const,
        pkce: "S256" as const,
        supportsRefresh: true,
        expiryStrategy: "expires_in" as const,
        redirectMode: "loopback-fixed" as const,
        registrationHint: { redirectUri: "", scopes: "", docsUrl: "" },
      }
      await saveCustomDesigns(paths, [design])

      const repos = reposWithPlatform(makePlatform({ oauthProviderId: "custom:acme-oauth" }))
      const credential = makeCredential()

      const providerId = await resolveCredentialProviderId({
        repos,
        paths,
        credential,
        context: "group",
      })

      expect(providerId).toBe("custom:acme-oauth")
    })
  })

  it("SECURITY: a dangling platform.oauthProviderId degrades to undefined (never a fallback)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = reposWithPlatform(makePlatform({ oauthProviderId: "custom:never-created" }))
      const credential = makeCredential()

      const providerId = await resolveCredentialProviderId({
        repos,
        paths,
        credential,
        context: "group",
      })

      expect(providerId).toBeUndefined()
    })
  })

  it("no provider source at all (no platform hint) → degrades to undefined", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = reposWithPlatform(makePlatform())
      const credential = makeCredential()

      const providerId = await resolveCredentialProviderId({
        repos,
        paths,
        credential,
        context: "group",
      })

      expect(providerId).toBeUndefined()
    })
  })

  it("a platform lookup failure degrades to undefined (no legacy fallback to fall back to)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = reposWithPlatform(undefined)
      const credential = makeCredential()

      const providerId = await resolveCredentialProviderId({
        repos,
        paths,
        credential,
        context: "group",
      })

      expect(providerId).toBeUndefined()
    })
  })

  it("an UNLINKED credential (platformId null) skips the platform lookup entirely and degrades to undefined", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const repos = {
        platforms: { get: vi.fn() },
      } as unknown as Pick<Repositories, "platforms">
      const credential = makeCredential({ platformId: null })

      const providerId = await resolveCredentialProviderId({
        repos,
        paths,
        credential,
        context: "group",
      })

      expect(providerId).toBeUndefined()
      expect(repos.platforms.get).not.toHaveBeenCalled()
    })
  })

  it("a corrupt designs store degrades to built-ins-only resolution (fail-closed store, does not crash the caller)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const { writeFile } = await import("node:fs/promises")
      await writeFile(paths.oauthDesignsFile, "{ not valid json", "utf-8")

      const repos = reposWithPlatform(makePlatform({ oauthProviderId: "github" }))
      const credential = makeCredential()
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

      try {
        const providerId = await resolveCredentialProviderId({
          repos,
          paths,
          credential,
          context: "group",
        })

        // github is a built-in — still resolves even though the custom store is corrupt.
        expect(providerId).toBe("github")
        expect(
          writeSpy.mock.calls.some((call) =>
            String(call[0]).includes("custom OAuth designs store failed to load"),
          ),
        ).toBe(true)
      } finally {
        writeSpy.mockRestore()
      }
    })
  })
})
