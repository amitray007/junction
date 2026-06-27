// SPDX-License-Identifier: AGPL-3.0-only
// Root route — document shell + top-level navigation.
// No @junction/core import. All data flows through server functions in data.functions.ts.

import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router"
import type { ReactNode } from "react"
import "../styles/app.css"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Junction" },
    ],
    // Inline SVG favicon. serve.mjs forwards every request to the SSR handler and
    // does NOT serve static files, so a public/favicon.ico would 404; declaring the
    // icon here stops the browser's /favicon.ico probe (the startup warning's cause).
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E" +
          "%3Crect width='32' height='32' rx='6' fill='%231f2937'/%3E" +
          "%3Ctext x='16' y='22' font-family='system-ui,sans-serif' font-size='18' " +
          "font-weight='700' fill='%23fff' text-anchor='middle'%3EJ%3C/text%3E%3C/svg%3E",
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav className="nav">
          <span className="nav-brand">Junction</span>
          <Link to="/" className="nav-link">
            Dashboard
          </Link>
          <Link to="/platforms" className="nav-link">
            Platforms
          </Link>
          <Link to="/credentials" className="nav-link">
            Credentials
          </Link>
          <Link to="/profiles" className="nav-link">
            Profiles
          </Link>
        </nav>
        <main className="main">{children}</main>
        <Scripts />
      </body>
    </html>
  )
}
