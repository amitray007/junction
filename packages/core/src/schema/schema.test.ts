// SPDX-License-Identifier: AGPL-3.0-only
// Schema behavior tests — pure schema, no filesystem/JUNCTION_HOME needed.
// Covers: the multi-account wedge, valid entity parsing, invalid rejection,
// convention helpers, ID generators, and the security invariant (no secret survives parse).

import { describe, expect, it } from "vitest"

import { newCredentialId, newPlatformId, newProfileId } from "../ids/index.js"
import { CredentialSchema, OAuthMetaSchema } from "./credential.js"
import { PlatformSchema } from "./platform.js"
import {
  CredentialIdSchema,
  namespacedTool,
  PlatformIdSchema,
  ProfileIdSchema,
  ProfileNameSchema,
  ToolNamespaceSchema,
} from "./primitives.js"
import { ProfileSchema } from "./profile.js"
import { SourceRefSchema } from "./source-ref.js"

// ---------------------------------------------------------------------------
// THE WEDGE — headline test
// ---------------------------------------------------------------------------

describe("multi-account wedge", () => {
  it("allows two Credentials with the same platformId and different profileName", () => {
    const platformId = newPlatformId()

    const credWork = CredentialSchema.safeParse({
      id: newCredentialId(),
      platformId,
      profileName: "work",
      kind: "oauth2",
      secretRef: "keyring:github-work",
    })

    const credPersonal = CredentialSchema.safeParse({
      id: newCredentialId(),
      platformId,
      profileName: "personal",
      kind: "api-key",
      secretRef: "keyring:github-personal",
    })

    expect(credWork.success).toBe(true)
    expect(credPersonal.success).toBe(true)

    if (!credWork.success || !credPersonal.success) return // narrow for TS

    // Both share the same platformId (the wedge)
    expect(credWork.data.platformId).toBe(platformId)
    expect(credPersonal.data.platformId).toBe(platformId)

    // But are distinct entities with different profileNames and IDs
    expect(credWork.data.profileName).toBe("work")
    expect(credPersonal.data.profileName).toBe("personal")
    expect(credWork.data.id).not.toBe(credPersonal.data.id)
  })

  it("allows a Platform to be parsed independently, one Platform for many Credentials", () => {
    const platform = PlatformSchema.safeParse({
      id: newPlatformId(),
      kind: "mcp",
      displayName: "GitHub",
    })
    expect(platform.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// VALID ENTITY PARSING
// ---------------------------------------------------------------------------

describe("valid entity parsing", () => {
  it("parses a full Profile with a SourceRef", () => {
    const platformId = newPlatformId()
    const credentialId = newCredentialId()

    const result = ProfileSchema.safeParse({
      id: newProfileId(),
      name: "work",
      sources: [
        {
          platformId,
          credentialId,
          toolNamespace: "github_work",
          enabled: true,
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  it("SourceRef parses without credentialId (public/no-auth source)", () => {
    const result = SourceRefSchema.safeParse({
      platformId: newPlatformId(),
      toolNamespace: "public_api",
      enabled: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.credentialId).toBeUndefined()
    }
  })

  it("SourceRef parses with credentialId (credentialed source — unchanged)", () => {
    const result = SourceRefSchema.safeParse({
      platformId: newPlatformId(),
      credentialId: newCredentialId(),
      toolNamespace: "github_work",
      enabled: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.credentialId).toBeTruthy()
    }
  })

  it("parses a Credential with optional oauthMeta", () => {
    const result = CredentialSchema.safeParse({
      id: newCredentialId(),
      platformId: newPlatformId(),
      profileName: "work",
      kind: "oauth2",
      secretRef: "keyring:linear-work",
      oauthMeta: {
        scopes: ["read:issue", "write:comment"],
        expiresAt: "2026-12-31T00:00:00Z",
      },
    })
    expect(result.success).toBe(true)
  })

  it("parses a Platform with optional specUrl and baseUrl", () => {
    const result = PlatformSchema.safeParse({
      id: newPlatformId(),
      kind: "openapi",
      displayName: "Acme API",
      specUrl: "https://acme.example.com/openapi.json",
      baseUrl: "https://acme.example.com",
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// INVALID REJECTION
// ---------------------------------------------------------------------------

describe("invalid entity rejection", () => {
  it("rejects a toolNamespace with spaces and capitals (e.g. 'Github Work')", () => {
    const result = SourceRefSchema.safeParse({
      platformId: newPlatformId(),
      credentialId: newCredentialId(),
      toolNamespace: "Github Work",
      enabled: true,
    })
    expect(result.success).toBe(false)
  })

  it("rejects a toolNamespace with uppercase letters", () => {
    const result = SourceRefSchema.safeParse({
      platformId: newPlatformId(),
      credentialId: newCredentialId(),
      toolNamespace: "GitHub",
      enabled: true,
    })
    expect(result.success).toBe(false)
  })

  it("rejects a Credential with a bad kind", () => {
    const result = CredentialSchema.safeParse({
      id: newCredentialId(),
      platformId: newPlatformId(),
      profileName: "work",
      kind: "password", // not a valid CredentialKind
      secretRef: "keyring:something",
    })
    expect(result.success).toBe(false)
  })

  it("rejects a Credential with empty id", () => {
    const result = CredentialSchema.safeParse({
      id: "",
      platformId: newPlatformId(),
      profileName: "work",
      kind: "api-key",
      secretRef: "keyring:something",
    })
    expect(result.success).toBe(false)
  })

  it("rejects a Profile with a bad profileName containing special characters ('Work!')", () => {
    const result = ProfileSchema.safeParse({
      id: newProfileId(),
      name: "Work!", // capitals + exclamation mark
      sources: [],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CONVENTION HELPERS
// ---------------------------------------------------------------------------

describe("namespacedTool helper", () => {
  it("produces '<namespace>__<tool>' for valid inputs", () => {
    expect(namespacedTool("github_work", "list_issues")).toBe("github_work__list_issues")
  })

  it("throws for an invalid namespace (uppercase)", () => {
    expect(() => namespacedTool("GitHub", "list_issues")).toThrow()
  })

  it("throws for an invalid namespace (spaces)", () => {
    expect(() => namespacedTool("github work", "list_issues")).toThrow()
  })

  it("throws for a tool containing '__' (would make the namespace split ambiguous)", () => {
    expect(() => namespacedTool("github", "a__b")).toThrow()
  })

  it("throws for an invalid tool (uppercase)", () => {
    expect(() => namespacedTool("github", "ListIssues")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// CHARSET CONTRACTS — load-bearing for the increment-27 multi-profile
// scoped-proxy naming parse (sources/scoped-proxy.ts). A profile name can
// never contain `_` and a tool namespace can never contain `__` — that is
// what makes splitting a `<profileName>__<namespace>__<tool>` name on the
// FIRST `__` deterministic. These are regression tests, not new behavior —
// both schemas already reject these charsets; this asserts the contract
// explicitly so a future loosening trips a test, not a silent naming bug.
// ---------------------------------------------------------------------------

describe("charset contracts (load-bearing for multi-profile tool-name parsing)", () => {
  it("ProfileNameSchema rejects an underscore in the profile name", () => {
    expect(ProfileNameSchema.safeParse("client_acme").success).toBe(false)
  })

  it("ProfileNameSchema accepts hyphens (the sanctioned separator)", () => {
    expect(ProfileNameSchema.safeParse("client-acme").success).toBe(true)
  })

  it("ToolNamespaceSchema rejects a double underscore in the namespace", () => {
    expect(ToolNamespaceSchema.safeParse("github__work").success).toBe(false)
  })

  it("ToolNamespaceSchema accepts single underscores between segments", () => {
    expect(ToolNamespaceSchema.safeParse("github_work").success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ID GENERATORS
// ---------------------------------------------------------------------------

describe("ID generators", () => {
  it("newPlatformId() produces distinct non-empty IDs that parse as PlatformIdSchema", () => {
    const a = newPlatformId()
    const b = newPlatformId()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(0)
    expect(PlatformIdSchema.safeParse(a).success).toBe(true)
  })

  it("newCredentialId() produces distinct non-empty IDs that parse as CredentialIdSchema", () => {
    const a = newCredentialId()
    const b = newCredentialId()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(0)
    expect(CredentialIdSchema.safeParse(a).success).toBe(true)
  })

  it("newProfileId() produces distinct non-empty IDs that parse as ProfileIdSchema", () => {
    const a = newProfileId()
    const b = newProfileId()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(0)
    expect(ProfileIdSchema.safeParse(a).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SECURITY — secrets-as-references invariant
// ---------------------------------------------------------------------------

describe("security: no plaintext secret survives Credential parse", () => {
  it("strips an extra 'secret' field — only secretRef survives, never plaintext", () => {
    // Simulate a stray `secret` field on the raw input (e.g. from a bad serializer).
    const raw = {
      id: newCredentialId(),
      platformId: newPlatformId(),
      profileName: "work",
      kind: "api-key" as const,
      secretRef: "keyring:github-work",
      // This field must NOT appear on the parsed result — Zod strips unknown keys.
      secret: "PLAINTEXT_SECRET_DO_NOT_STORE",
    }

    const result = CredentialSchema.safeParse(raw)
    expect(result.success).toBe(true)

    if (!result.success) return // narrow

    // The parsed Credential MUST have secretRef (the opaque handle)...
    expect(result.data.secretRef).toBe("keyring:github-work")

    // ...and MUST NOT carry any `secret` field (Zod strips unknown keys by default).
    expect(Object.hasOwn(result.data, "secret")).toBe(false)
    // Ensure no value leaks under any key name resembling plaintext
    expect(JSON.stringify(result.data)).not.toContain("PLAINTEXT_SECRET_DO_NOT_STORE")
  })

  it("OAuthMetaSchema strips unknown keys — a stray token value never survives parse", () => {
    // Guard against a future maintainer switching OAuthMetaSchema to
    // .passthrough()/loose: a raw refresh token must never survive into oauthMeta
    // (the secrets-as-references invariant). This test fails if strip is removed.
    const result = OAuthMetaSchema.safeParse({
      scopes: ["repo"],
      expiresAt: null,
      refreshToken: "RAW_REFRESH_TOKEN_DO_NOT_STORE",
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(Object.hasOwn(result.data, "refreshToken")).toBe(false)
    expect(JSON.stringify(result.data)).not.toContain("RAW_REFRESH_TOKEN_DO_NOT_STORE")
  })
})
