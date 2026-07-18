// SPDX-License-Identifier: AGPL-3.0-only
// designs-store tests — round-trip, FAIL-CLOSED corrupt-file behavior (the
// deliberate D1 difference from tool-pins.ts's fail-open), 0600, namespace
// enforcement at load, and the re-read-under-lock-refuses-on-corruption
// write guard. Mirrors tool-pins.test.ts's structure/coverage.

import { readFile, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { ensureHome } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"
import {
  type CustomOAuthDesign,
  loadCustomDesigns,
  parseCustomOAuthDesign,
  saveCustomDesigns,
} from "./designs-store.js"

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

describe("loadCustomDesigns", () => {
  it("missing file (first run) → ok([]), no error", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const result = await loadCustomDesigns(paths)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) expect(result.value).toEqual([])
    })
  })

  it("round-trip: saveCustomDesigns then loadCustomDesigns returns the same designs", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const design = makeDesign()
      const saveResult = await saveCustomDesigns(paths, [design])
      expect(saveResult.isOk()).toBe(true)

      const loadResult = await loadCustomDesigns(paths)
      expect(loadResult.isOk()).toBe(true)
      if (loadResult.isOk()) expect(loadResult.value).toEqual([design])
    })
  })

  it("FAIL CLOSED (D1): corrupt (invalid JSON) file → TYPED ERROR, NOT silent-empty (the deliberate tool-pins difference)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      await writeFile(paths.oauthDesignsFile, "{ not valid json", "utf-8")

      const result = await loadCustomDesigns(paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("parse-failed")
    })
  })

  it("FAIL CLOSED: wrong-shape JSON → TYPED ERROR, NOT silent-empty", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      await writeFile(paths.oauthDesignsFile, JSON.stringify({ nonsense: true }), "utf-8")

      const result = await loadCustomDesigns(paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("parse-failed")
    })
  })

  it("FAIL CLOSED: wrong version literal → TYPED ERROR, NOT silent-empty", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      await writeFile(paths.oauthDesignsFile, JSON.stringify({ v: 99, designs: {} }), "utf-8")

      const result = await loadCustomDesigns(paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("parse-failed")
    })
  })

  it('D3 — NAMESPACE ENFORCED AT LOAD: a hand-edited file smuggling id:"github" (non-custom-prefixed) fails the parse', async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const smuggled = { ...makeDesign(), id: "github" }
      await writeFile(
        paths.oauthDesignsFile,
        JSON.stringify({ v: 1, designs: { github: smuggled } }),
        "utf-8",
      )

      const result = await loadCustomDesigns(paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("parse-failed")
    })
  })

  it("D3 — NAMESPACE ENFORCED AT LOAD: a non-custom-prefixed id that isn't even a real built-in still fails the parse", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const smuggled = { ...makeDesign(), id: "not-custom-prefixed" }
      await writeFile(
        paths.oauthDesignsFile,
        JSON.stringify({ v: 1, designs: { "not-custom-prefixed": smuggled } }),
        "utf-8",
      )

      const result = await loadCustomDesigns(paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("parse-failed")
    })
  })

  it("a record key that disagrees with its own design.id → TYPED ERROR (fail closed, defensive)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const design = makeDesign({ id: "custom:real-id" })
      await writeFile(
        paths.oauthDesignsFile,
        JSON.stringify({ v: 1, designs: { "custom:different-key": design } }),
        "utf-8",
      )

      const result = await loadCustomDesigns(paths)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("parse-failed")
    })
  })
})

describe("saveCustomDesigns", () => {
  it("writes atomically at mode 0600", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const result = await saveCustomDesigns(paths, [makeDesign()])
      expect(result.isOk()).toBe(true)

      const { stat } = await import("node:fs/promises")
      const stats = await stat(paths.oauthDesignsFile)
      expect(stats.mode & 0o777).toBe(0o600)
    })
  })

  it("REFUSES to overwrite a corrupt file: save leaves the bytes untouched and returns refused-corrupt-file", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const corruptContent = "{ definitely not json — keep me for inspection"
      await writeFile(paths.oauthDesignsFile, corruptContent, "utf-8")

      const result = await saveCustomDesigns(paths, [makeDesign()])
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("refused-corrupt-file")

      const after = await readFile(paths.oauthDesignsFile, "utf-8")
      expect(after).toBe(corruptContent)
    })
  })

  it("saving an empty list over an existing file clears it (round-trips to [])", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      await saveCustomDesigns(paths, [makeDesign()])
      const clearResult = await saveCustomDesigns(paths, [])
      expect(clearResult.isOk()).toBe(true)

      const loadResult = await loadCustomDesigns(paths)
      expect(loadResult.isOk()).toBe(true)
      if (loadResult.isOk()) expect(loadResult.value).toEqual([])
    })
  })

  it("saving multiple designs round-trips all of them", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const a = makeDesign({ id: "custom:a", displayName: "A" })
      const b = makeDesign({ id: "custom:b", displayName: "B" })
      const result = await saveCustomDesigns(paths, [a, b])
      expect(result.isOk()).toBe(true)

      const loadResult = await loadCustomDesigns(paths)
      expect(loadResult.isOk()).toBe(true)
      if (loadResult.isOk()) {
        expect(loadResult.value.sort((x, y) => x.id.localeCompare(y.id))).toEqual([a, b])
      }
    })
  })
})

describe("parseCustomOAuthDesign", () => {
  it("a valid design → ok", () => {
    const result = parseCustomOAuthDesign(makeDesign())
    expect(result.ok).toBe(true)
  })

  it("a non-custom-prefixed id → rejected", () => {
    const result = parseCustomOAuthDesign(makeDesign({ id: "github" }))
    expect(result.ok).toBe(false)
  })

  it("an id with uppercase letters → rejected (charset)", () => {
    const result = parseCustomOAuthDesign(makeDesign({ id: "custom:Acme" }))
    expect(result.ok).toBe(false)
  })

  it("a non-URL authorizationUrl → rejected", () => {
    const result = parseCustomOAuthDesign(makeDesign({ authorizationUrl: "not-a-url" }))
    expect(result.ok).toBe(false)
  })
})
