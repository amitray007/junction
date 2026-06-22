// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Only run source tests; never compiled output or deps.
    include: ["packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
})
