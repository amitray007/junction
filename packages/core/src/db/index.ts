// SPDX-License-Identifier: AGPL-3.0-only
// Database initialization: open better-sqlite3, apply Drizzle migrations, enable pragmas.
// better-sqlite3 is synchronous by design; ResultAsync keeps callers async-safe
// and makes a future libsql swap a driver change, not a signature change.

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { ResultAsync } from "neverthrow"
import type { DbError } from "../errors/index.js"
import type { JunctionPaths } from "../paths/index.js"
import * as schema from "./schema.js"

export type Db = ReturnType<typeof drizzle<typeof schema>>

export function getDatabase(paths: JunctionPaths): ResultAsync<Db, DbError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Ensure the home dir exists — better-sqlite3 will not create the parent
      // directory, so `profile list` on a brand-new home (no prior `init`) would
      // otherwise fail with "directory does not exist". One-shot async setup;
      // the DB driver itself is synchronous below.
      await mkdir(path.dirname(paths.dbFile), { recursive: true })
      const sqlite = new Database(paths.dbFile)
      sqlite.pragma("foreign_keys = ON")
      sqlite.pragma("journal_mode = WAL")
      const db = drizzle(sqlite, { schema })
      const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url))
      migrate(db, { migrationsFolder })
      return db
    })(),
    (cause): DbError => ({ kind: "migration-failed", cause }),
  )
}
