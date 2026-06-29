// SPDX-License-Identifier: AGPL-3.0-only
// ComingSoon — quiet pill affordance for deferred actions.
// Reads as intentional and honest, not unfinished.
// Usage:
//   <ComingSoon /> — renders the quiet pill inline
//   <ComingSoonAction label="Add Platform" cliHint="junction platform add" /> — disabled control + pill + hint

import { Button } from "./button.js"
import { cn } from "./cn.js"
import { MonoCode } from "./code.js"

// ─── Pill ─────────────────────────────────────────────────────────────────────

export function ComingSoon({ className }: { readonly className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center px-2 py-0.5 rounded-[var(--radius-full)]", className)}
      style={{
        backgroundColor: "var(--gray-100)",
        color: "var(--gray-700)",
        fontSize: "var(--text-caption)",
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      Coming soon
    </span>
  )
}

// ─── Action wrapper ───────────────────────────────────────────────────────────
// Renders a disabled Button (secondary variant), the Coming soon pill beside it,
// and a one-line hint pointing to the CLI command where the action exists today.

interface ComingSoonActionProps {
  /** Button / action label (e.g. "Add Platform"). Title Case. */
  readonly label: string
  /** Short CLI command the user can run today (e.g. "junction platform add"). */
  readonly cliHint?: string
  readonly className?: string
}

export function ComingSoonAction({ label, cliHint, className }: ComingSoonActionProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled>
          {label}
        </Button>
        <ComingSoon />
      </div>
      {cliHint && (
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
          Use <MonoCode style={{ color: "var(--blue-text)" }}>{cliHint}</MonoCode> for now.
        </p>
      )}
    </div>
  )
}
