// SPDX-License-Identifier: AGPL-3.0-only
// @junction/openapi-client public API — narrow barrel.
// SOURCE-AGNOSTIC: generic OpenAPI/REST connector. No vendor code.

export { parseSpec } from "./parse.js"
export { createOpenApiProvider } from "./provider.js"
export { countOperationsByTag, extractTools } from "./tools.js"
