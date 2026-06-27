// SPDX-License-Identifier: AGPL-3.0-only
// 404 page for unmatched routes. Wired as the router's defaultNotFoundComponent
// (see router.tsx). Replaces TanStack Router's generic `<p>Not Found</p>` and
// silences the "no notFoundComponent configured" startup warning.

import { Link } from "@tanstack/react-router"

export function NotFound() {
  return (
    <div>
      <h1>Page not found</h1>
      <p>That route doesn’t exist on this dashboard.</p>
      <Link to="/" className="nav-link">
        Back to Dashboard
      </Link>
    </div>
  )
}
