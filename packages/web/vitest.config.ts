// SPDX-License-Identifier: AGPL-3.0-only
// Web-scoped Vitest config — happy-dom environment for component tests.
// MUST be separate from the root vitest.config.ts (which is Node environment).
// Adding happy-dom to the root would break the 565 Node test suites.
// The root config's include glob picks up *.test.tsx under packages/web/src/ too,
// but its environment is "node" — component tests that touch the DOM must run here.

import { defineConfig } from "vitest/config"

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    name: "web-components",
    environment: "happy-dom",
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 10_000,
  },
})
