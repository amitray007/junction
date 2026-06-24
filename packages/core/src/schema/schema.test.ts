// SPDX-License-Identifier: AGPL-3.0-only
// Schema behavior tests — pure schema, no filesystem/JUNCTION_HOME needed.
// Covers: the multi-account wedge, valid entity parsing, invalid rejection,
// convention helpers, ID generators, and the security invariant (no secret survives parse).

import { describe, expect, it } from "vitest"

import { newCredentialId, newPlatformId, newProfileId } from "../ids/index.js"
import { CredentialSchema } from "./credential.js"
import { PlatformSchema } from "./platform.js"
import {
  CredentialIdSchema,
  deriveMcpEndpointPath,
  namespacedTool,
  PlatformIdSchema,
  ProfileIdSchema,
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
      mcpEndpointPath: "/profiles/work/mcp",
    })

    expect(result.success).toBe(true)
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
      mcpEndpointPath: "/profiles/Work!/mcp",
    })
    expect(result.success).toBe(false)
  })

  it("rejects a Profile with mcpEndpointPath not starting with /profiles/", () => {
    const result = ProfileSchema.safeParse({
      id: newProfileId(),
      name: "work",
      sources: [],
      mcpEndpointPath: "/api/work/mcp",
    })
    expect(result.success).toBe(false)
  })

  it("rejects a Profile with mcpEndpointPath not ending with /mcp", () => {
    const result = ProfileSchema.safeParse({
      id: newProfileId(),
      name: "work",
      sources: [],
      mcpEndpointPath: "/profiles/work/tools",
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
})

describe("deriveMcpEndpointPath helper", () => {
  it("produces '/profiles/<name>/mcp' for a valid name", () => {
    expect(deriveMcpEndpointPath("work")).toBe("/profiles/work/mcp")
  })

  it("throws for an invalid profile name (uppercase)", () => {
    expect(() => deriveMcpEndpointPath("Work")).toThrow()
  })

  it("throws for an invalid profile name (special chars)", () => {
    expect(() => deriveMcpEndpointPath("work!")).toThrow()
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
})
