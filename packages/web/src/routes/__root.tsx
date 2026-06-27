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
