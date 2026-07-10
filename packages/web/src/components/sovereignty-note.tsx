// SPDX-License-Identifier: AGPL-3.0-only
// Sovereignty note — the light §1a sovereignty signal (design doc
// docs/design/apps-ready-to-connect.md §1a "show where the token lives" /
// "surface the sandbox boundary"). Two small, quiet exports:
//
//   <CredentialSovereigntyNote /> — shown on a CONNECTED surface/credential:
//     "this credential is stored encrypted on this machine and never leaves
//     the process." Metadata-only — states a fact about the storage model,
//     never renders a secret/token value.
//
//   <SandboxBoundaryNote />       — the honest CLI-sandbox summary, reused
//     verbatim by cli-sandbox-explainer.tsx (Component 2) so the two
//     components never drift on the sandbox story (increment 36 §Step 2).
//
// Both are plain text, not badges — this is a fact, not a status.

import { Lock, ShieldCheck } from "lucide-react"

export function CredentialSovereigntyNote({ className }: { readonly className?: string }) {
  return (
    <p
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "var(--text-caption)",
        color: "var(--gray-700)",
        margin: 0,
      }}
    >
      <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      This credential is stored encrypted on this machine and never leaves the process.
    </p>
  )
}

export function SandboxBoundaryNote({ className }: { readonly className?: string }) {
  return (
    <p
      className={className}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "6px",
        fontSize: "var(--text-caption)",
        color: "var(--gray-700)",
        margin: 0,
      }}
    >
      <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-[1px]" aria-hidden="true" />
      junction runs the binary sandboxed and isolated from your filesystem, with the credential
      passed as one environment variable — never on the command line, and never through the CLI's
      own saved login.
    </p>
  )
}
