// SPDX-License-Identifier: AGPL-3.0-only
// @junction/graphql-client — public API.
// Narrow exports: only what callers (cli, tests) need.

export { callGraphQl, DEFAULT_TIMEOUT_MS, RESPONSE_BYTE_CAP } from "./http.js"
export { introspectSchema } from "./introspect.js"
// Exported for tests
export { assertOperationType, getOperationType } from "./operation.js"
export { createGraphQlProvider } from "./provider.js"
