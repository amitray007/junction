// SPDX-License-Identifier: AGPL-3.0-only
// 404 page for unmatched routes. Wired as the router's defaultNotFoundComponent
// (see router.tsx). Uses ui/ primitives and the Geist tokens (inc 24.5+).

import { Link } from "@tanstack/react-router"
import { Button } from "../ui/button.js"

export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-20 text-center">
      {/* Faint mono 404 marker (tokens migrated from the retired inc-23 set inc 24.6) */}
      <p
        aria-hidden="true"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-h1)",
          fontWeight: 600,
          color: "var(--gray-400)",
          lineHeight: 1,
          userSelect: "none",
        }}
      >
        404
      </p>

      <div className="flex flex-col items-center gap-2">
        <h1
          style={{
            fontSize: "var(--text-h1)",
            fontWeight: 600,
            color: "var(--gray-1000)",
            margin: 0,
          }}
        >
          Page not found
        </h1>
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
          That route doesn't exist on this dashboard.
        </p>
      </div>

      <Button variant="secondary" asChild>
        <Link to="/">Back to Dashboard</Link>
      </Button>
    </div>
  )
}
