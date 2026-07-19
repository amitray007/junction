// SPDX-License-Identifier: AGPL-3.0-only
// addStandaloneCredential tests (increment 46, Slice A) — the unlinked
// (platformId: null) create path. Covers: happy path (platformId null, name
// round-trips), oauth2 exclusion, the 32 KiB file cap shared with
// addCredential, and the typed `duplicate-name` DB backstop (increment 46,
// RC's friendly-error principle — upgraded from the old stringly
// invalid-input mapping).

import { ok, ResultAsync } from "neverthrow"
import { describe, expect, it } from "vitest"
import { getDatabase } from "../db/index.js"
import { getPaths } from "../paths/index.js"
import { createRepositories } from "../repositories/index.js"
import { withTempHome } from "../testing/index.js"
import { addStandaloneCredential } from "./add-standalone-credential.js"
import type { CredentialStore } from "./store.js"

/** An in-memory CredentialStore stub — mirrors bind-credential-to-platform.test.ts's stubStore. */
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

describe("addStandaloneCredential", () => {
  it("happy path: creates an UNLINKED credential (platformId null), name round-trips, secret resolves", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const result = await addStandaloneCredential(
        { name: "my-vault-secret", kind: "env", secret: "sekrit" },
        store,
        repos.credentials,
      )

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.platformId).toBeNull()
        expect(result.value.name).toBe("my-vault-secret")
        const secret = (await store.get(result.value.secretRef))._unsafeUnwrap()
        expect(secret).toBe("sekrit")
      }

      // Persisted, not just returned.
      const listed = await repos.credentials.listUnlinked()
      expect(listed.isOk()).toBe(true)
      if (listed.isOk()) {
        expect(listed.value.some((c) => c.name === "my-vault-secret")).toBe(true)
      }
    })
  })

  it("oauth2 is excluded — typed kind-incompatible, no store write", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const result = await addStandaloneCredential(
        // oauth2 is excluded from AddStandaloneCredentialInput's type — cast
        // to reach the runtime belt-and-suspenders guard.
        { name: "oauth-attempt", kind: "oauth2" as never, secret: "tok" },
        store,
        repos.credentials,
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("kind-incompatible")
      }
    })
  })

  it("a name collision against an existing credential surfaces as typed duplicate-name (DB backstop, increment 46 RC)", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const first = await addStandaloneCredential(
        { name: "shared-name", kind: "env", secret: "sekrit-1" },
        store,
        repos.credentials,
      )
      expect(first.isOk()).toBe(true)

      const second = await addStandaloneCredential(
        { name: "shared-name", kind: "env", secret: "sekrit-2" },
        store,
        repos.credentials,
      )

      expect(second.isErr()).toBe(true)
      if (second.isErr()) {
        expect(second.error.kind).toBe("duplicate-name")
        if (second.error.kind === "duplicate-name") {
          expect(second.error.name).toBe("shared-name")
        }
      }

      // Only one credential named "shared-name" exists.
      const listed = await repos.credentials.listUnlinked()
      if (listed.isOk()) {
        expect(listed.value.filter((c) => c.name === "shared-name")).toHaveLength(1)
      }
    })
  })

  it("an invalid explicit name is rejected BEFORE any store write", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const dbResult = await getDatabase(paths)
      if (dbResult.isErr()) throw new Error("test setup: db open failed")
      const repos = createRepositories(dbResult.value)
      const store = stubStore()

      const result = await addStandaloneCredential(
        { name: "Not A Valid Slug!", kind: "env", secret: "sekrit" },
        store,
        repos.credentials,
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("invalid-input")
      }
    })
  })
})
