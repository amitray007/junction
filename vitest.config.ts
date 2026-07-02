// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Resolve @junction/* packages to SOURCE in tests, not the built dist/.
// The packages' `exports` maps point at dist/, which `pnpm verify` does not
// build — so without these aliases any test importing @junction/* would run
// against stale/absent compiled output. Tests assert against source; the built
// bin is covered separately by the child-process smoke tests.
// inc-18 gotcha: these aliases MUST be present in EVERY vitest project — dropping
// them from any project silently runs against absent dist/ and produces false-greens.
const coreSrc = fileURLToPath(new URL("./packages/core/src", import.meta.url))
const mcpServerSrc = fileURLToPath(new URL("./packages/mcp/server/src", import.meta.url))
const mcpClientSrc = fileURLToPath(new URL("./packages/mcp/client/src", import.meta.url))
const openapiClientSrc = fileURLToPath(new URL("./packages/openapi-client/src", import.meta.url))
const graphqlClientSrc = fileURLToPath(new URL("./packages/graphql-client/src", import.meta.url))
const platformOrchestrationSrc = fileURLToPath(
  new URL("./packages/platform-orchestration/src", import.meta.url),
)

// Shared alias map — must appear in BOTH projects (inc-18 gotcha).
const alias = {
  "@junction/core/testing": `${coreSrc}/testing/index.ts`,
  "@junction/core": `${coreSrc}/index.ts`,
  "@junction/mcp-server": `${mcpServerSrc}/index.ts`,
  "@junction/mcp-client": `${mcpClientSrc}/index.ts`,
  "@junction/openapi-client": `${openapiClientSrc}/index.ts`,
  "@junction/graphql-client": `${graphqlClientSrc}/index.ts`,
  "@junction/platform-orchestration": `${platformOrchestrationSrc}/index.ts`,
}

// The 6 child-process integration suites that spawn `node packages/cli/dist/index.js`
// (or real sandbox subprocesses). Under full parallel load these oversubscribe the CPU —
// spawned children get starved and fail at times UNDER the 20s timeout (e.g. 5.3s, 6.4s).
// A bigger timeout is NOT the fix; serialising these 6 against each other is.
const INTEGRATION_FILES = [
  "packages/cli/src/cli.test.ts",
  "packages/cli/src/commands/credential.test.ts",
  "packages/cli/src/commands/profile.test.ts",
  "packages/cli/src/commands/platform.test.ts",
  "packages/cli/src/commands/mcp.test.ts",
  "packages/cli/src/commands/serve.test.ts",
  "packages/cli/src/commands/keys.test.ts",
  "packages/core/src/sandbox/sandbox.test.ts",
]

export default defineConfig({
  // Configure esbuild to use the automatic React 17+ JSX runtime for .tsx test files.
  // This matches the cli tsconfig "jsx": "react-jsx" and avoids needing to import React
  // in every tsx file.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // projects: split into two concurrent projects so the fast unit suites still
    // parallelize while the child-process integration suites run sequentially
    // (fileParallelism: false) to avoid CPU oversubscription.
    projects: [
      {
        // ── unit: all fast suites — full parallelism (default) ──────────────
        test: {
          name: "unit",
          testTimeout: 20_000,
          hookTimeout: 20_000,
          include: ["packages/**/src/**/*.test.ts", "packages/**/src/**/*.test.tsx"],
          // Exclude web .test.tsx (run under packages/web/vitest.config.ts with happy-dom),
          // dist, node_modules, and the 6 integration files.
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "packages/web/**/*.test.tsx",
            ...INTEGRATION_FILES,
          ],
          alias,
        },
        esbuild: {
          jsx: "automatic",
        },
      },
      {
        // ── integration: child-process suites — serial to prevent CPU starvation ──
        // fileParallelism: false → each file runs one at a time within this project.
        // The unit project still runs fully in parallel on other workers.
        test: {
          name: "integration",
          testTimeout: 20_000,
          hookTimeout: 20_000,
          fileParallelism: false,
          include: INTEGRATION_FILES,
          alias,
        },
        esbuild: {
          jsx: "automatic",
        },
      },
    ],
  },
})
