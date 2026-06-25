// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // No 'splitting' — tsdown transpiles each source file individually (not a bundle).
  // The dynamic import of ./tui/index.js in index.ts is a real Node runtime dynamic
  // import: dist/tui/index.js is only loaded when launchDashboard() is called, so
  // junction status --json never pays the ink + react load cost (lazy-load perf rule).
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
})
