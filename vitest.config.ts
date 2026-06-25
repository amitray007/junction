// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Resolve @junction/core (and its /testing subpath) to SOURCE in tests, not the
// built dist/. The package `exports` map points at dist/, which `pnpm verify`
// does not build — so without this alias any test importing @junction/core would
// run against stale/absent compiled output (and miss build-only assets like the
// packaged migrations). Tests assert against source; the built bin is covered
// separately by the child-process smoke tests.
const coreSrc = fileURLToPath(new URL("./packages/core/src", import.meta.url))

export default defineConfig({
  test: {
    // Only run source tests; never compiled output or deps.
    include: ["packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    alias: {
      "@junction/core/testing": `${coreSrc}/testing/index.ts`,
      "@junction/core": `${coreSrc}/index.ts`,
    },
  },
})
