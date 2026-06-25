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

export default defineConfig({
  test: {
    // Only run source tests; never compiled output or deps.
    include: ["packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    alias: {
      "@junction/core/testing": `${coreSrc}/testing/index.ts`,
      "@junction/core": `${coreSrc}/index.ts`,
      "@junction/mcp-server": `${mcpServerSrc}/index.ts`,
    },
  },
})
