// SPDX-License-Identifier: AGPL-3.0-only
// Drizzle SQLite table definitions matching inc-4 entity shapes.
// Row types are derived via $inferSelect/$inferInsert — do NOT redeclare.
// Zod schemas (schema/*.ts) remain the boundary/validation shapes.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const platforms = sqliteTable("platforms", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  displayName: text("display_name").notNull(),
  specUrl: text("spec_url"),
  baseUrl: text("base_url"),
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
  mcpEndpointPath: text("mcp_endpoint_path").notNull(),
})

export const sourceRefs = sqliteTable("source_refs", {
  id: text("id").primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => profiles.id, { onDelete: "cascade" }),
  platformId: text("platform_id").notNull(),
  credentialId: text("credential_id").notNull(),
  toolNamespace: text("tool_namespace").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
})

export type PlatformRow = typeof platforms.$inferSelect
export type NewPlatformRow = typeof platforms.$inferInsert
export type CredentialRow = typeof credentials.$inferSelect
export type NewCredentialRow = typeof credentials.$inferInsert
export type ProfileRow = typeof profiles.$inferSelect
export type NewProfileRow = typeof profiles.$inferInsert
export type SourceRefRow = typeof sourceRefs.$inferSelect
export type NewSourceRefRow = typeof sourceRefs.$inferInsert
