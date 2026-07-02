// SPDX-License-Identifier: AGPL-3.0-only
// Drizzle SQLite table definitions matching inc-4 entity shapes.
// Row types are derived via $inferSelect/$inferInsert — do NOT redeclare.
// Zod schemas (schema/*.ts) remain the boundary/validation shapes.

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const platforms = sqliteTable("platforms", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  displayName: text("display_name").notNull(),
  specUrl: text("spec_url"),
  baseUrl: text("base_url"),
  /** JSON-serialized McpConnection — optional; meaningful when kind === "mcp" */
  connection: text("connection"),
  /** JSON-serialized OpenApiConnection — optional; meaningful when kind === "openapi" */
  openapi: text("openapi"),
  /** JSON-serialized GraphQlConnection — optional; meaningful when kind === "graphql" */
  graphql: text("graphql"),
  /** JSON-serialized CliConnection — optional; meaningful when kind === "cli" */
  cli: text("cli"),
})

export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  platformId: text("platform_id")
    .notNull()
    .references(() => platforms.id),
  profileName: text("profile_name").notNull(),
  kind: text("kind").notNull(),
  // secrets-as-references: ONLY a handle, NEVER a secret value
  secretRef: text("secret_ref").notNull(),
  // JSON-serialized OAuthMeta (reserved for OAuth increment)
  oauthMeta: text("oauth_meta"),
})

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
})

export const sourceRefs = sqliteTable(
  "source_refs",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    platformId: text("platform_id")
      .notNull()
      .references(() => platforms.id, { onDelete: "restrict" }),
    // nullable: absent when source has no credential (public/no-auth source)
    // RESTRICT still protects referenced credentials — NULL is FK-exempt
    credentialId: text("credential_id").references(() => credentials.id, {
      onDelete: "restrict",
    }),
    toolNamespace: text("tool_namespace").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    /** JSON-serialized ToolFilter — optional; absent means expose all upstream tools */
    toolFilter: text("tool_filter"),
  },
  (table) => [
    uniqueIndex("source_refs_profile_ns_unique").on(table.profileId, table.toolNamespace),
  ],
)

// ---------------------------------------------------------------------------
// api_keys / api_key_profiles — increment 27 junction-keys / single-endpoint
// MCP auth. See docs/methods/27-junction-keys-single-endpoint.md §2.2.
// ---------------------------------------------------------------------------

export const apiKeys = sqliteTable(
  "api_keys",
  {
    // ApiKeyId ULID; doubles as the token's keyid segment (PK lookup on verify)
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    // hex sha256 of the secret segment only — never the secret itself
    secretHash: text("secret_hash").notNull(),
    // 'profile' | 'profiles' | 'global' — stored, not derived from live count
    scope: text("scope").notNull(),
    createdAt: integer("created_at").notNull(),
    // NULL until first successful auth
    lastUsedAt: integer("last_used_at"),
    // NULL = active; revoke sets a timestamp (row retained for inc-31 audit)
    revokedAt: integer("revoked_at"),
  },
  (table) => [uniqueIndex("api_keys_secret_hash_unique").on(table.secretHash)],
)

export const apiKeyProfiles = sqliteTable(
  "api_key_profiles",
  {
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
  },
  (table) => [
    // Composite PK (api_key_id, profile_id) — scope 'profile' → exactly 1 row,
    // 'profiles' → ≥2, 'global' → 0.
    uniqueIndex("api_key_profiles_pk").on(table.apiKeyId, table.profileId),
  ],
)

export type PlatformRow = typeof platforms.$inferSelect
export type NewPlatformRow = typeof platforms.$inferInsert
export type CredentialRow = typeof credentials.$inferSelect
export type NewCredentialRow = typeof credentials.$inferInsert
export type ProfileRow = typeof profiles.$inferSelect
export type NewProfileRow = typeof profiles.$inferInsert
export type SourceRefRow = typeof sourceRefs.$inferSelect
export type NewSourceRefRow = typeof sourceRefs.$inferInsert
export type ApiKeyRow = typeof apiKeys.$inferSelect
export type NewApiKeyRow = typeof apiKeys.$inferInsert
export type ApiKeyProfileRow = typeof apiKeyProfiles.$inferSelect
export type NewApiKeyProfileRow = typeof apiKeyProfiles.$inferInsert
