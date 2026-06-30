// SPDX-License-Identifier: AGPL-3.0-only
// RefreshButton — a manual "refetch this page's data now" control for the list routes.
// Junction's data changes out of band (CLI, other agents, another tab); this lets the
// user pull the latest on demand without a full browser reload. Calls router.invalidate(),
// which re-runs the route loaders.

import { useRouter } from "@tanstack/react-router"
import { RefreshCw } from "lucide-react"
import { useState } from "react"
import { cn } from "./cn.js"

export function RefreshButton({ className }: { readonly className?: string }) {
  const router = useRouter()
  const [spinning, setSpinning] = useState(false)

  async function handleRefresh() {
    setSpinning(true)
    try {
      await router.invalidate()
    } finally {
      // Keep the spin visible at least one rotation even on instant localhost refetch.
      setTimeout(() => setSpinning(false), 500)
    }
  }

  return (
    <button
      type="button"
      aria-label="Refresh"
      title="Refresh data"
      onClick={handleRefresh}
      disabled={spinning}
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        "h-[var(--control-height)] w-[var(--control-height)] rounded-[var(--radius-6)]",
        "border border-[var(--alpha-400)] bg-[var(--bg-100)]",
        "transition-[color,background-color,transform] duration-[var(--motion-fast)]",
        "hover:bg-[var(--gray-100)] active:not-disabled:scale-[0.97]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue-700)]",
        "disabled:cursor-default",
        className,
      )}
      style={{ color: "var(--gray-700)" }}
    >
      <RefreshCw
        className={cn("h-4 w-4", spinning && "motion-safe:animate-spin")}
        aria-hidden="true"
      />
    </button>
  )
}
