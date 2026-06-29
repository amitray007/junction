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
const SERVER_ONLY = ["better-sqlite3", "@napi-rs/keyring", "@junction/core"]

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
