// SPDX-License-Identifier: AGPL-3.0-only
// KeyringStore — credential store backed by the OS keyring via @napi-rs/keyring.
// Service = "junction" (fixed); account = opaque secretRef ULID (never platform/profile name).
// get() returning null = no such entry (NOT an error). A throw = keyring unavailable → store-unavailable.

import { err, ok, ResultAsync } from "neverthrow"
import type { CredentialError } from "../errors/index.js"
import type { CredentialStore } from "./store.js"

export function createKeyringStore(): CredentialStore {
  return {
    backend: "keyring",

    get(secretRef: string): ResultAsync<string | null, CredentialError> {
      return new ResultAsync<string | null, CredentialError>(
        (async () => {
          try {
            const { Entry } = await import("@napi-rs/keyring")
            const value = new Entry("junction", secretRef).getPassword()
            return ok<string | null, CredentialError>(value)
          } catch (cause) {
            return err<string | null, CredentialError>({ kind: "store-unavailable", cause })
          }
        })(),
      )
    },

    set(secretRef: string, secret: string): ResultAsync<void, CredentialError> {
      return new ResultAsync<void, CredentialError>(
        (async () => {
          try {
            const { Entry } = await import("@napi-rs/keyring")
            new Entry("junction", secretRef).setPassword(secret)
            return ok<void, CredentialError>(undefined)
          } catch (cause) {
            return err<void, CredentialError>({ kind: "store-unavailable", cause })
          }
        })(),
      )
    },

    delete(secretRef: string): ResultAsync<void, CredentialError> {
      return new ResultAsync<void, CredentialError>(
        (async () => {
          try {
            const { Entry } = await import("@napi-rs/keyring")
            try {
              new Entry("junction", secretRef).deleteCredential()
            } catch {
              // Idempotent: absent entry → ok
            }
            return ok<void, CredentialError>(undefined)
          } catch (cause) {
            return err<void, CredentialError>({ kind: "store-unavailable", cause })
          }
        })(),
      )
    },
  }
}
