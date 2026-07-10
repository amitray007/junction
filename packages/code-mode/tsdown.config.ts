// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  // Downlevel Explicit Resource Management (`using`) to the Symbol.dispose
  // helper pattern. quickjs-executor.ts uses `using` for QuickJS handle
  // cleanup, but native `using` in ESM lands only in Node 24 — the repo's
  // floor is Node 20 (CI runs 20 + 22). Without an explicit target, rolldown/
  // oxc passes `using` through untranspiled and the built dist/index.js throws
  // `SyntaxError: Unexpected identifier` on import under Node 20/22 (tsconfig's
  // `target: es2023` does NOT reach the tsdown transform). node20 keeps the
  // floor honest while still downleveling ERM.
  target: "node20",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
})
