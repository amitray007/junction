// SPDX-License-Identifier: AGPL-3.0-only
// @junction/openapi-client public API — narrow barrel.
// SOURCE-AGNOSTIC: generic OpenAPI/REST connector. No vendor code.

export type { SpecBaseUrlError } from "./base-url.js"
export { resolveSpecBaseUrl } from "./base-url.js"
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
