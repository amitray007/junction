// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Resolve @junction/* packages to SOURCE in tests, not the built dist/.
// The packages' `exports` maps point at dist/, which `pnpm verify` does not
// build — so without these aliases any test importing @junction/* would run
// against stale/absent compiled output. Tests assert against source; the built
// bin is covered separately by the child-process smoke tests.
const coreSrc = fileURLToPath(new URL("./packages/core/src", import.meta.url))
const mcpServerSrc = fileURLToPath(new URL("./packages/mcp/server/src", import.meta.url))
const mcpClientSrc = fileURLToPath(new URL("./packages/mcp/client/src", import.meta.url))
const openapiClientSrc = fileURLToPath(new URL("./packages/openapi-client/src", import.meta.url))

export default defineConfig({
  // Configure esbuild to use the automatic React 17+ JSX runtime for .tsx test files.
  // This matches the cli tsconfig "jsx": "react-jsx" and avoids needing to import React
  // in every tsx file.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // Only run source tests; never compiled output or deps.
    include: ["packages/**/src/**/*.test.ts", "packages/**/src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    alias: {
      "@junction/core/testing": `${coreSrc}/testing/index.ts`,
      "@junction/core": `${coreSrc}/index.ts`,
      "@junction/mcp-server": `${mcpServerSrc}/index.ts`,
      "@junction/mcp-client": `${mcpClientSrc}/index.ts`,
      "@junction/openapi-client": `${openapiClientSrc}/index.ts`,
    },
  },
})
