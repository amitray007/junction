// SPDX-License-Identifier: AGPL-3.0-only
// CredentialStore interface — maps opaque secret_ref handles to plaintext secrets.
// Plaintext exists only in memory; never logged, persisted in DB, or returned over MCP.

import type { ResultAsync } from "neverthrow"
import type { CredentialError } from "../errors/index.js"

/**
 * Maps an opaque secretRef (ULID from the credentials table) to its plaintext.
 * get() returns null for a missing ref — NOT an error, mirroring keyring null-mapping.
 */
export interface CredentialStore {
  /** Backend identifier — never contains secrets. */
  readonly backend: "keyring" | "encrypted-file"
  get(secretRef: string): ResultAsync<string | null, CredentialError>
  set(secretRef: string, secret: string): ResultAsync<void, CredentialError>
  delete(secretRef: string): ResultAsync<void, CredentialError>
}
