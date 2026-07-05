// SPDX-License-Identifier: AGPL-3.0-only
// @junction/openapi-client public API — narrow barrel.
// SOURCE-AGNOSTIC: generic OpenAPI/REST connector. No vendor code.

export type { SpecBaseUrlError } from "./base-url.js"
export { resolveSpecBaseUrl } from "./base-url.js"
export type { BoundParam, BuildAndExecuteRequestArgs } from "./http.js"
// Shared request-binding engine (increment 30.7) — reused by @junction/http-client.
export {
  buildAndExecuteRequest,
  DEFAULT_TIMEOUT_MS,
  injectAuth,
  RESPONSE_BYTE_CAP,
  validatePathValue,
} from "./http.js"
export { sanitizeOperationId } from "./naming.js"
export { parseSpec } from "./parse.js"
export { createOpenApiProvider } from "./provider.js"
export type { FoundRawOperation, TagCount } from "./tools.js"
export {
  countOperationsByTag,
  extractTools,
  findOperationByOperationId,
  hasAmbiguousSanitizedName,
} from "./tools.js"
