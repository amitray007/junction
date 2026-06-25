// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/db/schema.ts",
  out: "./packages/core/src/db/migrations",
})
