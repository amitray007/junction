// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
})
