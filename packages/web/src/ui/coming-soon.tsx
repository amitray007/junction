// SPDX-License-Identifier: AGPL-3.0-only
// ComingSoon — quiet pill affordance for deferred actions/sections.
// Reads as intentional and honest, not unfinished.
// Usage:
//   <ComingSoon /> — renders the quiet pill inline
//   <ComingSoonAction label="Add Platform" cliHint="junction platform add" /> — disabled control + pill + hint

import type { ReactNode } from "react"
import { cn } from "./cn.js"

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
// Renders a disabled button labelled by `label`, the Coming soon pill beside it,
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
        {/* Disabled button — visually present, non-interactive */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="inline-flex items-center justify-center gap-2 h-[var(--control-height)] px-3 rounded-[var(--radius-6)] border border-[var(--alpha-400)] select-none cursor-not-allowed opacity-50"
          style={{
            backgroundColor: "var(--bg-100)",
            color: "var(--gray-1000)",
            fontSize: "var(--text-label)",
            fontWeight: 500,
          }}
        >
          {label}
        </button>
        <ComingSoon />
      </div>
      {cliHint && (
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
          Use{" "}
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-mono)",
              color: "var(--blue-text)",
            }}
          >
            {cliHint}
          </code>{" "}
          for now.
        </p>
      )}
    </div>
  )
}

// ─── Section tag variant ──────────────────────────────────────────────────────
// For wrapping an entire section that is Coming soon — renders children
// (a visual illustration) plus a footer with the pill + hint.

interface ComingSoonSectionProps {
  readonly children?: ReactNode
  readonly hint?: string
  readonly className?: string
}

export function ComingSoonSection({ children, hint, className }: ComingSoonSectionProps) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {children}
      <div className="flex items-center gap-3">
        <ComingSoon />
        {hint && (
          <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
            {hint}
          </p>
        )}
      </div>
    </div>
  )
}
