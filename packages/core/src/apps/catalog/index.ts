// SPDX-License-Identifier: AGPL-3.0-only
// Catalog loader — imports the committed catalog.generated.ts (pure in-memory
// data, zero fs) and re-validates each entry against AppCatalogEntrySchema at
// module load as a belt-and-suspenders check (increment 30.8, method file §2a).
//
// This is the ONLY module that reads CATALOG_ENTRIES — catalog.ts's legacy
// getApp()/listApps() are superseded by these (see docs/methods/30.8-app-catalog-schema.md §4).

import { AppCatalogEntrySchema } from "../catalog-schema.js"
import { CATALOG_ENTRIES } from "./catalog.generated.js"

function validateEntries(): typeof CATALOG_ENTRIES {
  const parsed = CATALOG_ENTRIES.map((entry) => {
    const result = AppCatalogEntrySchema.safeParse(entry)
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      // Module-load-time integrity check on a committed, codegen'd file (never user/request input).
      // nosemgrep: no-bare-throw-in-core -- category 1 (module-load-time integrity check): fails fast on a committed codegen'd file
      throw new Error(
        `catalog: generated entry "${(entry as { id?: string }).id}" failed AppCatalogEntrySchema ` +
          `re-validation at load time: ${issues}`,
      )
    }
    return result.data
  })
  return parsed
}

const ENTRIES = validateEntries()
const ENTRIES_BY_ID = new Map(ENTRIES.map((e) => [e.id, e]))

/** Catalog lookup by app id — the richer AppCatalogEntry shape (surfaces + help). */
export function getCatalogEntry(id: string) {
  return ENTRIES_BY_ID.get(id)
}

/** All catalog entries, richer shape (surfaces + help). */
export function listCatalogEntries() {
  return [...ENTRIES]
}
