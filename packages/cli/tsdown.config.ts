// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
})
