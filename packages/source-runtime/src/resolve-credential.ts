// SPDX-License-Identifier: AGPL-3.0-only
// resolveCredentialSecret — resolve a credential's plaintext secret from the store.
// Composition root: wires @junction/core (repos + CredentialStore) together.
//
// SECRET DISCIPLINE: the secret flows only into the provider transport; it is
// NEVER logged, serialized, or returned in any output.

import type { CredentialError, CredentialKind, DbError } from "@junction/core"
import {
  createCredentialStore,
  err,
  type JunctionPaths,
  ok,
  type Repositories,
  type Result,
  ResultAsync,
} from "@junction/core"

// ---------------------------------------------------------------------------
// ResolveCredentialError — discriminated union for credential resolution failures
// ---------------------------------------------------------------------------

/** Error returned by resolveCredentialSecret — wraps the underlying error kind. */
export type ResolveCredentialError =
  | { kind: "db"; error: DbError }
  | { kind: "credential"; error: CredentialError }

// ---------------------------------------------------------------------------
// resolveCredentialSecret
// ---------------------------------------------------------------------------

/**
 * Resolve a credential's plaintext secret, kind, and account name from the store.
 *
 * Absent or empty credentialId → {secret:null, kind:"env", account:"public"} with
 * NO store touch. "env" is an arbitrary-but-documented choice for the no-credential
 * fast path — buildProvider's cli branch only consults `kind` when `secret` is
 * non-null, so this default is never actually read; it exists purely so the return
 * shape doesn't need `kind` to be optional.
 *
 * Present credentialId → looks up the credential in the DB, opens the credential
 * store, and reads the secret by its secretRef. `kind` is the credential row's
 * stored CredentialKind, threaded through so callers building a cli provider know
 * whether to inject the value directly (env) or materialize it to a file (file).
 * Any other CredentialKind (bearer/api-key/oauth2) is passed through as-is — only
 * the cli branch of buildProvider narrows it further (down to CliSecret's
 * `"env" | "file"`, folding every non-file kind to "env" — legacy back-compat,
 * since historically every cli credential was labeled "bearer").
 *
 * SECRET DISCIPLINE: the returned secret is never logged or serialized by this
 * module. The caller passes it directly to buildProvider and nothing else.
 */
export function resolveCredentialSecret(
  repos: Repositories,
  paths: JunctionPaths,
  credentialId?: string,
): ResultAsync<
  { secret: string | null; kind: CredentialKind; account: string },
  ResolveCredentialError
> {
  if (credentialId === undefined || credentialId === "") {
    return new ResultAsync(
      Promise.resolve(
        ok({ secret: null as string | null, kind: "env" as CredentialKind, account: "public" }),
      ),
    )
  }

  const work = async (): Promise<
    Result<{ secret: string | null; kind: CredentialKind; account: string }, ResolveCredentialError>
  > => {
    const credResult = await repos.credentials.get(credentialId)
    if (credResult.isErr()) {
      return err({ kind: "db" as const, error: credResult.error })
    }
    const credential = credResult.value

    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) {
      return err({ kind: "credential" as const, error: storeResult.error })
    }
    const store = storeResult.value

    const secretResult = await store.get(credential.secretRef)
    if (secretResult.isErr()) {
      return err({ kind: "credential" as const, error: secretResult.error })
    }

    return ok({
      secret: secretResult.value,
      kind: credential.kind,
      // Increment 46 — a credential's account identity IS its `name` now
      // (Fable RA); `profileName` is gone.
      account: credential.name,
    })
  }

  return new ResultAsync(work())
}
