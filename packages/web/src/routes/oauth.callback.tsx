// SPDX-License-Identifier: AGPL-3.0-only
// /oauth/callback — the OAuth provider redirects the BROWSER here after
// consent (a top-level nav, NOT a server-fn call — there is no CSRF token on
// this request; `state` IS the CSRF guard, validated server-side against the
// pending-auth Map — see pending-auth.server.ts / oauth-connect.server.ts).
//
// This file NEVER imports @junction/core or @junction/source-runtime — all
// the sensitive work (state lookup, code exchange, token persist) happens
// inside handleOAuthCallbackFn (a createServerFn whose handler body is
// stripped from the client bundle). The loader just calls that server-fn,
// which itself throws redirect() to land on /credentials with an outcome
// flag — so this loader never returns a token, secret, or anything sensitive.
//
// Idempotent/single-use: the pending-auth Map's takePending() deletes on
// first read, so a re-run of this loader (e.g. a client-side back-nav) for
// the same `state` finds nothing pending and redirects to the clean
// error-state outcome rather than double-persisting.

import { createFileRoute } from "@tanstack/react-router"
import { handleOAuthCallbackFn } from "../server/oauth-connect.functions.js"

// Manual search validation (no zod — not a web dependency; matches the house
// style of fn-guards.server.ts's plain typeof checks). Both fields are
// optional here — an absent code/state is a valid (if malformed) callback
// request, and handleOAuthCallbackFn maps that to the error-state outcome.
interface CallbackSearch {
  code?: string
  state?: string
}

function validateCallbackSearch(search: Record<string, unknown>): CallbackSearch {
  return {
    code: typeof search.code === "string" ? search.code : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
  }
}

export const Route = createFileRoute("/oauth/callback")({
  validateSearch: validateCallbackSearch,
  loaderDeps: ({ search }) => ({ code: search.code, state: search.state }),
  loader: async ({ deps }) => {
    // handleOAuthCallbackFn always throws a redirect() (success or error) —
    // it never returns a value on this path. The await keeps the loader's
    // control flow explicit for reviewers.
    await handleOAuthCallbackFn({ data: { code: deps.code, state: deps.state } })
  },
})
