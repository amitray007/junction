// SPDX-License-Identifier: AGPL-3.0-only
// build-recipe tests — every GitHub surface × its offered auth mode → the
// expected ConnectPlan; the token→bearer precedence proof (NOT the recipe's
// oauth2 kind); descriptor-without-starters → RecipeError; oauth2 →
// oauth-handoff; {app} substitution; verifiable flag per surface.

import { describe, expect, it } from "vitest"
import {
  type ConnectPlan,
  planConnect,
  resolvePlatformId,
  toConnectPlanPreview,
} from "./build-recipe.js"
import { getCatalogEntry } from "./catalog/index.js"

const entry = getCatalogEntry("github")
if (entry === undefined) throw new Error("test fixture: github catalog entry missing")

function surface(kind: string) {
  const found = entry?.surfaces?.find((s) => s.kind === kind)
  if (found === undefined) throw new Error(`test fixture: github has no "${kind}" surface`)
  return found
}

describe("resolvePlatformId", () => {
  it("substitutes {app}", () => {
    expect(resolvePlatformId("{app}", "github")).toBe("github")
  })

  it("substitutes {app}-http", () => {
    expect(resolvePlatformId("{app}-http", "github")).toBe("github-http")
  })

  it("substitutes {kind} when a surfaceKind is provided (30.12 shape-compat)", () => {
    expect(resolvePlatformId("{app}-{kind}", "github", "openapi")).toBe("github-openapi")
  })

  it("leaves {kind} untouched when no surfaceKind is given", () => {
    expect(resolvePlatformId("{app}-{kind}", "github")).toBe("github-{kind}")
  })
})

describe("planConnect — openapi surface (oauth2 + token)", () => {
  const openapi = surface("openapi")

  it("token mode → credential plan, credentialKind bearer (NOT the recipe's oauth2)", () => {
    const plan = planConnect(entry, openapi, { authMode: "token" })
    expect("path" in plan && plan.path).toBe("credential")
    const credentialPlan = plan as Extract<ConnectPlan, { path: "credential" }>
    expect(credentialPlan.credentialKind).toBe("bearer")
    expect(openapi.build.credential.kind).toBe("oauth2") // the recipe's own default — proves precedence overrides it
    // 30.12: github's platformIdTemplate is now "{app}-{kind}" (multi-surface
    // groupability) — every surface resolves to a DISTINCT platformId.
    expect(credentialPlan.platformId).toBe("github-openapi")
    expect(credentialPlan.kind).toBe("openapi")
    expect(credentialPlan.verifiable).toBe(true)
    if (credentialPlan.platformInput.kind === "openapi") {
      expect(credentialPlan.platformInput.auth).toEqual({ scheme: "bearer" })
      expect(credentialPlan.platformInput.specUrl).toBe(
        openapi.connection.kind === "openapi" ? openapi.connection.specUrl : undefined,
      )
      expect(credentialPlan.platformInput.verifyOperationId).toBe("users/get-authenticated")
    } else {
      throw new Error("expected openapi platformInput")
    }
  })

  it("oauth2 mode → oauth-handoff, no inline write", () => {
    const plan = planConnect(entry, openapi, { authMode: "oauth2" })
    expect(plan).toEqual({ path: "oauth-handoff", providerId: "github" })
  })

  it("byo mode is unavailable on the openapi surface (only oauth2/token offered)", () => {
    const plan = planConnect(entry, openapi, { authMode: "byo" })
    expect(plan).toEqual({
      kind: "auth-mode-unavailable",
      requested: "byo",
      offered: ["oauth2", "token"],
    })
  })
})

describe("planConnect — graphql surface (oauth2 + token)", () => {
  const graphql = surface("graphql")

  it("token mode → credential plan, bearer", () => {
    const plan = planConnect(entry, graphql, { authMode: "token" })
    const credentialPlan = plan as Extract<ConnectPlan, { path: "credential" }>
    expect(credentialPlan.path).toBe("credential")
    expect(credentialPlan.credentialKind).toBe("bearer")
    // 30.12: distinct platformId per surface.
    expect(credentialPlan.platformId).toBe("github-graphql")
    expect(credentialPlan.kind).toBe("graphql")
    // graphql's verify hint is typenameProbe — a real primitive → verifiable.
    expect(credentialPlan.verifiable).toBe(true)
    if (credentialPlan.platformInput.kind === "graphql") {
      expect(credentialPlan.platformInput.auth).toEqual({ scheme: "bearer" })
    } else {
      throw new Error("expected graphql platformInput")
    }
  })

  it("oauth2 mode → oauth-handoff", () => {
    const plan = planConnect(entry, graphql, { authMode: "oauth2" })
    expect(plan).toEqual({ path: "oauth-handoff", providerId: "github" })
  })
})

describe("planConnect — mcp surface (oauth2 + token)", () => {
  const mcp = surface("mcp")

  it("token mode → credential plan, bearer, verifiable (listTools is a real primitive)", () => {
    const plan = planConnect(entry, mcp, { authMode: "token" })
    const credentialPlan = plan as Extract<ConnectPlan, { path: "credential" }>
    expect(credentialPlan.path).toBe("credential")
    expect(credentialPlan.credentialKind).toBe("bearer")
    // 30.12: distinct platformId per surface.
    expect(credentialPlan.platformId).toBe("github-mcp")
    expect(credentialPlan.kind).toBe("mcp")
    expect(credentialPlan.verifiable).toBe(true)
  })

  it("oauth2 mode → oauth-handoff", () => {
    const plan = planConnect(entry, mcp, { authMode: "oauth2" })
    expect(plan).toEqual({ path: "oauth-handoff", providerId: "github" })
  })
})

describe("planConnect — cli surface (single mode: token; descriptor, no starterTools shipped)", () => {
  const cli = surface("cli")

  it("has a single auth mode (token) so the recipe's own kind (bearer) is the default", () => {
    expect(cli.auth).toEqual([{ mode: "token" }])
    expect(cli.build.credential.kind).toBe("bearer")
  })

  it("token mode → descriptor-no-starter-tools RecipeError (cli ships zero starterTools)", () => {
    const plan = planConnect(entry, cli, { authMode: "token" })
    expect(plan).toEqual({ kind: "descriptor-no-starter-tools", surfaceKind: "cli" })
  })

  it("is not-verifiable per its verify hint (kind: none)", () => {
    expect(cli.verify).toEqual({ kind: "none" })
  })
})

describe("planConnect — http surface (single mode: token; descriptor WITH starterTools)", () => {
  const http = surface("http")

  it("{app}-{kind} platformIdTemplate resolves distinctly from the other surfaces (30.12: every surface now uses {app}-{kind}, http included)", () => {
    const platformId = resolvePlatformId(http.build.platformIdTemplate, entry.id, http.kind)
    expect(platformId).toBe("github-http")
  })

  it("token mode → credential plan with descriptor tools merged, verifiable:false (verify:none)", () => {
    const plan = planConnect(entry, http, { authMode: "token" })
    const credentialPlan = plan as Extract<ConnectPlan, { path: "credential" }>
    expect(credentialPlan.path).toBe("credential")
    expect(credentialPlan.credentialKind).toBe("bearer")
    expect(credentialPlan.platformId).toBe("github-http")
    expect(credentialPlan.kind).toBe("http")
    expect(credentialPlan.verifiable).toBe(false)
    if (credentialPlan.platformInput.kind === "http") {
      expect(credentialPlan.platformInput.descriptor.tools.length).toBeGreaterThan(0)
      expect(credentialPlan.platformInput.descriptor.auth).toEqual({ scheme: "bearer" })
      expect(credentialPlan.platformInput.descriptor.baseUrl).toBe("https://api.github.com")
    } else {
      throw new Error("expected http platformInput")
    }
  })
})

describe("planConnect — an auth mode the surface doesn't offer", () => {
  it("rejects with auth-mode-unavailable", () => {
    const cli = surface("cli")
    const plan = planConnect(entry, cli, { authMode: "byo" })
    expect(plan).toEqual({ kind: "auth-mode-unavailable", requested: "byo", offered: ["token"] })
  })
})

describe("toConnectPlanPreview", () => {
  it("never carries the raw connection/recipe — only metadata", () => {
    const openapi = surface("openapi")
    const plan = planConnect(entry, openapi, { authMode: "token" })
    if (plan.path !== "credential") throw new Error("expected credential plan")
    const preview = toConnectPlanPreview(entry, openapi, plan)
    expect(preview).toEqual({
      // 30.12: distinct platformId per surface.
      platformId: "github-openapi",
      kind: "openapi",
      connectionSummary: expect.stringContaining("GitHub"),
      authModes: ["oauth2", "token"],
      verifiable: true,
    })
    // No secret-shaped or connection-shaped keys leak through.
    expect(Object.keys(preview).sort()).toEqual(
      ["authModes", "connectionSummary", "kind", "platformId", "verifiable"].sort(),
    )
  })

  it("previews an oauth-handoff plan honestly (kind: oauth2-handoff, not verifiable)", () => {
    const openapi = surface("openapi")
    const plan = planConnect(entry, openapi, { authMode: "oauth2" })
    if (plan.path !== "oauth-handoff") throw new Error("expected oauth-handoff plan")
    const preview = toConnectPlanPreview(entry, openapi, plan)
    expect(preview.kind).toBe("oauth2-handoff")
    expect(preview.verifiable).toBe(false)
    // 30.12: distinct platformId per surface (oauth-handoff preview also
    // resolves through the surface's platformIdTemplate).
    expect(preview.platformId).toBe("github-openapi")
  })
})
