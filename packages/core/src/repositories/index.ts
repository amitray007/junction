// SPDX-License-Identifier: AGPL-3.0-only
// Repository factory — the single entry point for all persistence.

import type { Db } from "../db/index.js"
import { createCredentialsRepo } from "./credentials.js"
import { createPlatformsRepo } from "./platforms.js"
import { createProfilesRepo } from "./profiles.js"

export type { CredentialsRepo } from "./credentials.js"
export type { PlatformsRepo } from "./platforms.js"
export type { ProfilesRepo } from "./profiles.js"

export function createRepositories(db: Db) {
  return {
    platforms: createPlatformsRepo(db),
    credentials: createCredentialsRepo(db),
    profiles: createProfilesRepo(db),
  }
}

export type Repositories = ReturnType<typeof createRepositories>
