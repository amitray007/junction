// SPDX-License-Identifier: AGPL-3.0-only
// 404 page for unmatched routes. Wired as the router's defaultNotFoundComponent
// (see router.tsx). Uses ui/ primitives and tokens.

import { Link } from "@tanstack/react-router"
import { Button } from "../ui/button.js"

export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-20 text-center">
      {/* Large muted 404 — mono, instrument register */}
      <p
        aria-hidden="true"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "4rem",
          fontWeight: 700,
          color: "var(--surface-2)",
          lineHeight: 1,
          userSelect: "none",
        }}
      >
        404
      </p>

      <div className="flex flex-col items-center gap-2">
        <h1
          style={{
            fontSize: "var(--text-section)",
            fontWeight: 600,
            color: "var(--fg)",
            margin: 0,
          }}
        >
          Page not found
        </h1>
        <p style={{ fontSize: "var(--text-body)", color: "var(--muted)", margin: 0 }}>
          That route doesn't exist on this dashboard.
        </p>
      </div>

      <Button variant="secondary" asChild>
        <Link to="/">Back to Dashboard</Link>
      </Button>
    </div>
  )
}
