// SPDX-License-Identifier: AGPL-3.0-only
// @junction/openapi-client public API — narrow barrel.
// SOURCE-AGNOSTIC: generic OpenAPI/REST connector. No vendor code.

export type { SpecBaseUrlError } from "./base-url.js"
export { resolveSpecBaseUrl } from "./base-url.js"
export { parseSpec } from "./parse.js"
export { createOpenApiProvider } from "./provider.js"
export type { TagCount } from "./tools.js"
export { countOperationsByTag, extractTools } from "./tools.js"
