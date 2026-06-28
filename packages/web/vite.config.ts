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
    external: ["better-sqlite3", "@napi-rs/keyring", "@junction/core"],
  },
})
