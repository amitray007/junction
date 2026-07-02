// SPDX-License-Identifier: AGPL-3.0-only
// CLI `junction keys` child-process tests (increment 27, §4-Slice-B).
//
// Drives the BUILT junction binary (packages/cli/dist/index.js) end-to-end:
// create/list/revoke, mutually-exclusive scope flags, dedupe-by-id, unknown
// profile name failing the whole mint, idempotent revoke, and — critically —
// that `list` NEVER prints the secret.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { withTempHome } from "@junction/core/testing"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js")
const coreDistMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@junction/core/dist/migrations",
)
const builtBinReady = existsSync(distIndex) && existsSync(coreDistMigrations)

async function run(env: NodeJS.ProcessEnv, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [distIndex, ...args], { env })
    return { stdout, stderr, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 }
  }
}

async function createProfile(env: NodeJS.ProcessEnv, name: string) {
  await execFileAsync("node", [distIndex, "profile", "create", "--name", name, "--json"], { env })
}

describe.skipIf(!builtBinReady)("junction keys (built bin, child process)", () => {
  it("create --global mints a key, prints it once, and list never shows the secret", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }

      const created = await run(env, ["keys", "create", "--label", "demo", "--global", "--json"])
      expect(created.code).toBe(0)
      const parsed = JSON.parse(created.stdout.trim()) as {
        ok: boolean
        key: string
        keyid: string
        scope: string
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.key).toMatch(/^jct_[0-9A-HJKMNP-TV-Z]{26}_.+$/)
      expect(parsed.scope).toBe("global")

      const listed = await run(env, ["keys", "list", "--json"])
      expect(listed.code).toBe(0)
      expect(listed.stdout).not.toContain(parsed.key)
      const secretHalf = parsed.key.split("_").slice(2).join("_")
      expect(listed.stdout).not.toContain(secretHalf)

      const rows = JSON.parse(listed.stdout.trim()) as Array<{ keyid: string; label: string }>
      expect(rows.some((r) => r.keyid === parsed.keyid)).toBe(true)
    })
  })

  it("--global and --profile are mutually exclusive", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      await createProfile(env, "work")
      const result = await run(env, [
        "keys",
        "create",
        "--label",
        "bad",
        "--global",
        "--profile",
        "work",
        "--json",
      ])
      expect(result.code).not.toBe(0)
    })
  })

  it("single --profile mints a 'profile' scope key; two distinct --profile mints 'profiles'", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      await createProfile(env, "work")
      await createProfile(env, "personal")

      const single = await run(env, [
        "keys",
        "create",
        "--label",
        "single",
        "--profile",
        "work",
        "--json",
      ])
      expect(single.code).toBe(0)
      expect((JSON.parse(single.stdout.trim()) as { scope: string }).scope).toBe("profile")

      const multi = await run(env, [
        "keys",
        "create",
        "--label",
        "multi",
        "--profile",
        "work",
        "--profile",
        "personal",
        "--json",
      ])
      expect(multi.code).toBe(0)
      expect((JSON.parse(multi.stdout.trim()) as { scope: string }).scope).toBe("profiles")
    })
  })

  it("duplicate --profile names dedupe to a single-profile scope", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      await createProfile(env, "work")

      const result = await run(env, [
        "keys",
        "create",
        "--label",
        "dedupe",
        "--profile",
        "work",
        "--profile",
        "work",
        "--json",
      ])
      expect(result.code).toBe(0)
      expect((JSON.parse(result.stdout.trim()) as { scope: string }).scope).toBe("profile")
    })
  })

  it("unknown profile name fails the whole mint (all-or-nothing)", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      await createProfile(env, "work")

      const result = await run(env, [
        "keys",
        "create",
        "--label",
        "bad2",
        "--profile",
        "work",
        "--profile",
        "does-not-exist",
        "--json",
      ])
      expect(result.code).not.toBe(0)

      const listed = await run(env, ["keys", "list", "--json"])
      const rows = JSON.parse(listed.stdout.trim()) as unknown[]
      expect(rows.length).toBe(0)
    })
  })

  it("revoke is idempotent and accepts a full pasted token", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }

      const created = await run(env, ["keys", "create", "--label", "rev", "--global", "--json"])
      // keyid is already jct_-prefixed (matches list's / revoke's output shape).
      const { key, keyid } = JSON.parse(created.stdout.trim()) as { key: string; keyid: string }

      const first = await run(env, ["keys", "revoke", key, "--json"])
      expect(first.code).toBe(0)
      expect(JSON.parse(first.stdout.trim())).toMatchObject({ ok: true, keyid })

      // Idempotent: revoking again succeeds — pass the bare keyid this time
      // (strip the jct_ prefix) to also cover the bare-keyid input form.
      const second = await run(env, ["keys", "revoke", keyid.slice(4), "--json"])
      expect(second.code).toBe(0)

      const listed = await run(env, ["keys", "list", "--json"])
      const rows = JSON.parse(listed.stdout.trim()) as Array<{ keyid: string; status: string }>
      const row = rows.find((r) => r.keyid === keyid)
      expect(row?.status).toBe("revoked")
    })
  })

  it("revoke of an unknown keyid fails", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const result = await run(env, ["keys", "revoke", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--json"])
      expect(result.code).not.toBe(0)
    })
  })

  it("list on an empty DB returns an empty array", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      const result = await run(env, ["keys", "list", "--json"])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout.trim())).toEqual([])
    })
  })
})
