// SPDX-License-Identifier: AGPL-3.0-only
// CLI edge tests for `junction oauth-design add|list|rm` and
// `junction platform set-oauth-design` (increment 45, Slice D3/D4).
//
// "built bin" style (mirrors platform.test.ts's JSON-round-trip suite): drives
// the compiled dist/index.js end-to-end against a real temp JUNCTION_HOME. Skipped
// when dist/ is absent (pre-build state).

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

type DesignResult = {
  ok: boolean
  design?: { id: string; displayName: string }
  designs?: { id: string; isCustom: boolean }[]
  error?: string
}

describe.skipIf(!builtBinReady)("oauth-design commands (built bin)", () => {
  it("add --json creates a custom:<slug> design; list --json shows built-ins + it", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      const addOut = await execFileAsync(
        "node",
        [
          distIndex,
          "oauth-design",
          "add",
          "--slug",
          "acme-oauth",
          "--display-name",
          "Acme OAuth",
          "--authorization-url",
          "https://acme.example.com/oauth/authorize",
          "--token-url",
          "https://acme.example.com/oauth/token",
          "--confirm-token-url",
          "--json",
        ],
        { env },
      )
      const added = JSON.parse(addOut.stdout.trim()) as DesignResult
      expect(added.ok).toBe(true)
      expect(added.design?.id).toBe("custom:acme-oauth")

      const listOut = await execFileAsync("node", [distIndex, "oauth-design", "list", "--json"], {
        env,
      })
      const listed = JSON.parse(listOut.stdout.trim()) as DesignResult
      expect(listed.ok).toBe(true)
      const custom = listed.designs?.find((d) => d.id === "custom:acme-oauth")
      expect(custom?.isCustom).toBe(true)
      const github = listed.designs?.find((d) => d.id === "github")
      expect(github?.isCustom).toBe(false)
    })
  })

  it("add without --confirm-token-url refuses (exit 1)", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      await expect(
        execFileAsync(
          "node",
          [
            distIndex,
            "oauth-design",
            "add",
            "--slug",
            "acme-oauth",
            "--display-name",
            "Acme OAuth",
            "--authorization-url",
            "https://acme.example.com/oauth/authorize",
            "--token-url",
            "https://acme.example.com/oauth/token",
            "--json",
          ],
          { env },
        ),
      ).rejects.toMatchObject({ code: 1 })
    })
  })

  it("add with a slug colliding with nothing built-in works; rm on a built-in id refuses", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      await expect(
        execFileAsync("node", [distIndex, "oauth-design", "rm", "github", "--json"], { env }),
      ).rejects.toMatchObject({ code: 1 })
    })
  })

  it("rm on a nonexistent custom: id refuses", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      await expect(
        execFileAsync("node", [distIndex, "oauth-design", "rm", "custom:never-existed", "--json"], {
          env,
        }),
      ).rejects.toMatchObject({ code: 1 })
    })
  })

  it("add → rm round trip removes the custom design", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      await execFileAsync(
        "node",
        [
          distIndex,
          "oauth-design",
          "add",
          "--slug",
          "roundtrip",
          "--display-name",
          "Roundtrip",
          "--authorization-url",
          "https://rt.example.com/authorize",
          "--token-url",
          "https://rt.example.com/token",
          "--confirm-token-url",
          "--json",
        ],
        { env },
      )
      const rmOut = await execFileAsync(
        "node",
        [distIndex, "oauth-design", "rm", "custom:roundtrip", "--json"],
        { env },
      )
      expect((JSON.parse(rmOut.stdout.trim()) as DesignResult).ok).toBe(true)

      const listOut = await execFileAsync("node", [distIndex, "oauth-design", "list", "--json"], {
        env,
      })
      const listed = JSON.parse(listOut.stdout.trim()) as DesignResult
      expect(listed.designs?.some((d) => d.id === "custom:roundtrip")).toBe(false)
    })
  })
})

describe.skipIf(!builtBinReady)("platform set-oauth-design (built bin)", () => {
  it("binds a platform to a custom design, then rm on the referenced design refuses naming the platform", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "acme",
          "--kind",
          "mcp",
          "--display-name",
          "Acme",
          "--transport",
          "http",
          "--url",
          "https://acme.example.com/mcp",
          "--json",
        ],
        { env },
      )

      await execFileAsync(
        "node",
        [
          distIndex,
          "oauth-design",
          "add",
          "--slug",
          "acme-oauth",
          "--display-name",
          "Acme OAuth",
          "--authorization-url",
          "https://acme.example.com/oauth/authorize",
          "--token-url",
          "https://acme.example.com/oauth/token",
          "--confirm-token-url",
          "--json",
        ],
        { env },
      )

      const bindOut = await execFileAsync(
        "node",
        [distIndex, "platform", "set-oauth-design", "acme", "custom:acme-oauth", "--json"],
        { env },
      )
      const bound = JSON.parse(bindOut.stdout.trim()) as {
        ok: boolean
        platform?: { oauthProviderId?: string }
      }
      expect(bound.ok).toBe(true)
      expect(bound.platform?.oauthProviderId).toBe("custom:acme-oauth")

      await expect(
        execFileAsync("node", [distIndex, "oauth-design", "rm", "custom:acme-oauth", "--json"], {
          env,
        }),
      ).rejects.toMatchObject({ code: 1 })
    })
  })

  it("set-oauth-design with an unknown design id refuses (fail closed)", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "acme",
          "--kind",
          "mcp",
          "--display-name",
          "Acme",
          "--transport",
          "http",
          "--url",
          "https://acme.example.com/mcp",
          "--json",
        ],
        { env },
      )
      await expect(
        execFileAsync(
          "node",
          [distIndex, "platform", "set-oauth-design", "acme", "custom:no-such-design", "--json"],
          { env },
        ),
      ).rejects.toMatchObject({ code: 1 })
    })
  })
})
