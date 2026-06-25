// SPDX-License-Identifier: AGPL-3.0-only
// Database initialization: open better-sqlite3, apply Drizzle migrations, enable pragmas.
// better-sqlite3 is synchronous by design; ResultAsync keeps callers async-safe
// and makes a future libsql swap a driver change, not a signature change.

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
    Promise.resolve().then(() => {
      const sqlite = new Database(paths.dbFile)
      sqlite.pragma("foreign_keys = ON")
      sqlite.pragma("journal_mode = WAL")
      const db = drizzle(sqlite, { schema })
      const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url))
      migrate(db, { migrationsFolder })
      return db
    }),
    (cause): DbError => ({ kind: "migration-failed", cause }),
  )
}
