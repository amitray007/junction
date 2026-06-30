// SPDX-License-Identifier: AGPL-3.0-only
// DevAgentation — the agentation UI-annotation overlay, DEV-ONLY.
//
// agentation (https://www.agentation.com) lets you annotate the running web UI during
// development; an AI coding agent reads/answers the annotations over MCP. It is a dev
// tool and MUST NOT ship in production.
//
// Guards (belt + suspenders so nothing reaches the prod bundle or breaks SSR):
//   1. `import.meta.env.DEV` — false in `vite build`, so Vite dead-code-eliminates the
//      whole branch and the dynamic import() below never enters the production chunks.
//   2. Dynamic import() — agentation loads only on demand, client-side, never at SSR.
//   3. A mounted ref — render nothing until after hydration (the overlay is a client
//      portal; rendering it during SSR would mismatch).
//
// The `endpoint` points at the local agentation MCP server (default port 4747). The
// overlay degrades gracefully to local-only annotations if the server isn't running.

import { type ComponentType, useEffect, useState } from "react"

type AgentationComponent = ComponentType<{ endpoint?: string }>

// The agentation MCP server's default local endpoint. Override with VITE_AGENTATION_ENDPOINT.
const AGENTATION_ENDPOINT = import.meta.env.VITE_AGENTATION_ENDPOINT ?? "http://localhost:4747"

export function DevAgentation() {
  // Never do anything in a production build — this also lets Vite strip the import().
  if (!import.meta.env.DEV) return null
  return <DevAgentationInner />
}

function DevAgentationInner() {
  const [Agentation, setAgentation] = useState<AgentationComponent | null>(null)

  useEffect(() => {
    let cancelled = false
    // Client-only dynamic import — keeps agentation out of the SSR path entirely.
    import("agentation")
      .then((mod) => {
        if (!cancelled) setAgentation(() => mod.Agentation as AgentationComponent)
      })
      .catch(() => {
        // agentation failed to load (e.g. removed) — silently no-op in dev.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!Agentation) return null
  return <Agentation endpoint={AGENTATION_ENDPOINT} />
}
