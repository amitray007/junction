// SPDX-License-Identifier: AGPL-3.0-only
// bindCredentialToPlatform tests (increment 43, Phase 2 Slice A) — real-DB
// withTempHome, exercising the full gate stack: not-found (credential and
// platform), kind-incompatible, duplicate-account (the two-unlinked-same-
// account scenario), and the happy path (binds + appears in forPlatform +
// disappears from listUnlinked).

import { ok, ResultAsync } from "neverthrow"
import { describe, expect, it } from "vitest"
import { getDatabase } from "../db/index.js"
import { newPlatformId } from "../ids/index.js"
import { getPaths } from "../paths/index.js"
import { createRepositories } from "../repositories/index.js"
import type { Platform } from "../schema/platform.js"
import { withTempHome } from "../testing/index.js"
import { addStandaloneCredential } from "./add-standalone-credential.js"
import { bindCredentialToPlatform } from "./bind-credential-to-platform.js"
import type { CredentialStore } from "./store.js"

/** An in-memory CredentialStore stub — mirrors connect-from-catalog.test.ts's stubStore. */
function stubStore(): CredentialStore {
  const map = new Map<string, string>()
  return {
    backend: "encrypted-file" as const,
    get: (ref: string) =>
      new ResultAsync(Promise.resolve(ok(map.has(ref) ? (map.get(ref) as string) : null))),
    set: (ref: string, value: string) => {
      map.set(ref, value)
      return new ResultAsync(Promise.resolve(ok(undefined)))
    },
    delete: (ref: string) => {
      map.delete(ref)
      return new ResultAsync(Promise.resolve(ok(undefined)))
    },
  }
}

function envPlatform(id: string): Platform {
  return {
    id: id as never,
    kind: "cli" as const,
    displayName: "Test CLI Platform",
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

describe("bindCredentialToPlatform", () => {
  it("credential not-found -> typed not-found error, no write", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)

      const platformId = newPlatformId()
      await repos.platforms.create(envPlatform(platformId))

      const result = await bindCredentialToPlatform(
        { credentialsRepo: repos.credentials, platformsRepo: repos.platforms },
        "does-not-exist",
        platformId,
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("not-found")
        if (result.error.kind === "not-found") {
          expect(result.error.entity).toBe("credential")
        }
      }
    })
  })

  it("platform not-found -> typed not-found error, no write", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const created = await addStandaloneCredential(
        { name: "standalone-env", kind: "env", secret: "sekrit" },
        store,
        repos.credentials,
      )
      if (created.isErr()) throw new Error("test setup: addStandaloneCredential failed")

      const result = await bindCredentialToPlatform(
        { credentialsRepo: repos.credentials, platformsRepo: repos.platforms },
        String(created.value.id),
        "does-not-exist-platform",
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("not-found")
        if (result.error.kind === "not-found") {
          expect(result.error.entity).toBe("platform")
        }
      }

      // The credential is untouched (still unlinked).
      const reread = await repos.credentials.get(String(created.value.id))
      if (reread.isOk()) expect(reread.value.platformId).toBeNull()
    })
  })

  it("kind-incompatible -> refuses to bind an env credential to an oauth2-only platform", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const platformId = newPlatformId()
      // oauth2-scheme platform: kindsForOpenApiAuth({scheme:"oauth2"}) -> ["oauth2"];
      // isKindAccepted unions in "bearer" but NOT "env" — env must be refused.
      const platform: Platform = {
        id: platformId,
        kind: "openapi" as const,
        displayName: "Test OAuth2 OpenAPI Platform",
        openapi: {
          spec: { from: "url", url: "https://example.com/openapi.json" },
          auth: { scheme: "oauth2" },
        },
      }
      await repos.platforms.create(platform)

      const created = await addStandaloneCredential(
        { name: "standalone-env-2", kind: "env", secret: "sekrit" },
        store,
        repos.credentials,
      )
      if (created.isErr()) throw new Error("test setup: addStandaloneCredential failed")

      const result = await bindCredentialToPlatform(
        { credentialsRepo: repos.credentials, platformsRepo: repos.platforms },
        String(created.value.id),
        platformId,
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("kind-incompatible")
        if (result.error.kind === "kind-incompatible") {
          expect(result.error.requested).toBe("env")
          expect(result.error.allowed).not.toContain("env")
        }
      }

      // Untouched.
      const reread = await repos.credentials.get(String(created.value.id))
      if (reread.isOk()) expect(reread.value.platformId).toBeNull()
    })
  })

  it("duplicate-account: two unlinked standalone credentials both profileName 'default' -> binding the 2nd to the same platform is refused", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const platformId = newPlatformId()
      await repos.platforms.create(envPlatform(platformId))

      // addStandaloneCredential sets profileName = name (write-only legacy
      // column) — so seed both standalone creds' `name` (and thus
      // profileName) to the SAME "default" label to hit the guard.
      const first = await addStandaloneCredential(
        { name: "default", kind: "env", secret: "sekrit-1" },
        store,
        repos.credentials,
      )
      if (first.isErr()) throw new Error("test setup: first addStandaloneCredential failed")

      const second = await addStandaloneCredential(
        { name: "default-2", kind: "env", secret: "sekrit-2" },
        store,
        repos.credentials,
      )
      if (second.isErr()) throw new Error("test setup: second addStandaloneCredential failed")

      // Force the 2nd credential's profileName to collide with the 1st's —
      // addStandaloneCredential derives profileName from the (unique) name,
      // so the collision must be engineered directly via setProfileName to
      // reach the SAME real-world state addCredential's app-level guard
      // protects against (two credentials on one platform sharing an account
      // label), independent of standalone naming.
      const renamed = await repos.credentials.setProfileName(String(second.value.id), "default")
      if (renamed.isErr()) throw new Error("test setup: setProfileName failed")

      const firstBind = await bindCredentialToPlatform(
        { credentialsRepo: repos.credentials, platformsRepo: repos.platforms },
        String(first.value.id),
        platformId,
      )
      expect(firstBind.isOk()).toBe(true)

      const secondBind = await bindCredentialToPlatform(
        { credentialsRepo: repos.credentials, platformsRepo: repos.platforms },
        String(second.value.id),
        platformId,
      )
      expect(secondBind.isErr()).toBe(true)
      if (secondBind.isErr()) {
        expect(secondBind.error.kind).toBe("duplicate-account")
        if (secondBind.error.kind === "duplicate-account") {
          expect(secondBind.error.platformId).toBe(platformId)
          expect(secondBind.error.account).toBe("default")
        }
      }

      // The 2nd credential is STILL unlinked — the guard fired before the write.
      const reread = await repos.credentials.get(String(second.value.id))
      if (reread.isOk()) expect(reread.value.platformId).toBeNull()

      // Only the 1st credential is bound.
      const forPlatform = await repos.credentials.forPlatform(platformId)
      if (forPlatform.isOk()) expect(forPlatform.value).toHaveLength(1)
    })
  })

  it("happy path: an unlinked credential binds, platformId is set, appears in forPlatform, gone from listUnlinked", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const platformId = newPlatformId()
      await repos.platforms.create(envPlatform(platformId))

      const created = await addStandaloneCredential(
        { name: "standalone-happy", kind: "env", secret: "sekrit" },
        store,
        repos.credentials,
      )
      if (created.isErr()) throw new Error("test setup: addStandaloneCredential failed")

      const before = await repos.credentials.listUnlinked()
      if (before.isOk()) {
        expect(before.value.some((c) => c.id === created.value.id)).toBe(true)
      }

      const result = await bindCredentialToPlatform(
        { credentialsRepo: repos.credentials, platformsRepo: repos.platforms },
        String(created.value.id),
        platformId,
      )

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.platformId).toBe(platformId)
        expect(result.value.id).toBe(created.value.id)
      }

      const forPlatform = await repos.credentials.forPlatform(platformId)
      expect(forPlatform.isOk()).toBe(true)
      if (forPlatform.isOk()) {
        expect(forPlatform.value.map((c) => c.id)).toContain(created.value.id)
      }

      const afterUnlinked = await repos.credentials.listUnlinked()
      expect(afterUnlinked.isOk()).toBe(true)
      if (afterUnlinked.isOk()) {
        expect(afterUnlinked.value.some((c) => c.id === created.value.id)).toBe(false)
      }
    })
  })
})
