// SPDX-License-Identifier: AGPL-3.0-only
// Vite config for @junction/web — TanStack Start app (localhost-only dashboard).
//
// Plugin order: tanstackStart() MUST precede tailwind, which precedes viteReact().
// (Start compiles server fns first; tailwind must come after Start's transforms.)
// ssr.external: core + native deps MUST NOT enter the client bundle.
// server.host: bind dev server to loopback only.

import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Native / server-only modules that must never be bundled OR pre-optimized for the
// client. `@junction/core` transitively pulls in native .node binaries (better-sqlite3,
// @napi-rs/keyring) which Vite's dep optimizer (`vite dev`) cannot load — it would fail
// with UNLOADABLE_DEPENDENCY. They are server-only by design (reached via createServerFn).
// `@junction/platform-orchestration` depends on @junction/core (same native chain) plus
// the openapi/graphql spec parsers — also server-only (reached only via *.server.ts).
// `@junction/source-runtime` + the provider libs it lazy-imports (mcp-client / openapi-client /
// graphql-client) are reached ONLY via probe.server.ts (the inc-28 probe/call surface) — they
// pull the same native/parser chain, so they are server-only too. They MUST be direct web deps
// (package.json) AND externalized here: buildProvider does `await import("@junction/openapi-client")`
// at runtime, which under pnpm's isolated node_modules only resolves if web depends on them
// directly (a transitive dep of source-runtime is NOT resolvable from web's context) — the bug
// that made every OpenAPI/GraphQL probe silently return an empty tool list (inc 28 QA).
const SERVER_ONLY = [
  "better-sqlite3",
  "@napi-rs/keyring",
  "@junction/core",
  "@junction/platform-orchestration",
  "@junction/source-runtime",
  "@junction/mcp-client",
  "@junction/openapi-client",
  "@junction/graphql-client",
  "@scalar/openapi-parser",
  "graphql",
]

export default defineConfig({
  server: {
    host: "127.0.0.1",
  },
  plugins: [
    tanstackStart({ srcDirectory: "src" }),
    tailwindcss(),
    viteReact({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
  ],
  ssr: {
    // Keep core + native modules server-side only — never in the client bundle.
    external: SERVER_ONLY,
  },
  optimizeDeps: {
    // Don't let the dev-server dependency optimizer scan into the native .node binaries
    // behind @junction/core — it can't load them and `vite dev` would crash with
    // UNLOADABLE_DEPENDENCY. (Build-time exclusion is handled by ssr.external above.)
    exclude: SERVER_ONLY,
  },
})
