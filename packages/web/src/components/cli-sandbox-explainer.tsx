// SPDX-License-Identifier: AGPL-3.0-only
// CLI/sandbox explainer (increment 36, Component 2) — honest to junction's
// real execution model for a `cli`-kind surface. Verified in code (see the
// method file's "Load-bearing facts"): sandbox/{seatbelt,bubblewrap}.ts,
// sources/cli/provider.ts, schema/cli-connection.ts.
//
// junction NEVER installs the binary — the user installs it on the host
// (help.install.commands, below). junction runs the HOST binary at an
// operator-pinned ABSOLUTE path, sandboxed via Seatbelt (macOS) / bubblewrap
// (Linux): deny-default filesystem reads, the credential passed as ONE env
// var (never argv), and the CLI's own saved login (e.g. ~/.config/gh) is
// confined away — the env-var token is the working path, not the CLI's
// ambient auth. Honest caveats: CLI-tier network is validated-but-not-
// enforced by the sandbox harness; Seatbelt is Apple-deprecated (forward
// path: microVM — see docs/futures/deprecations.md).
//
// v1 = copy-paste only. NO server-side exec of verifyCmd (a web server
// spawning a host process is a real boundary, deferred — method file "Open
// decisions"). Pure presentational; no server-fn, no core import.

import type { AppHelp } from "../server/data.functions.js"
import { MonoCode } from "../ui/code.js"
import { SandboxBoundaryNote } from "./sovereignty-note.js"

const OS_LABELS: Record<string, string> = {
  brew: "macOS (Homebrew)",
  apt: "Linux (apt)",
  winget: "Windows (winget)",
}

export function CliSandboxExplainer({
  install,
  notes,
}: {
  readonly install: AppHelp["install"]
  /** Honest caveat slot (increment 36 §Step 2) — from the surface's own
   *  `notes[]` (SurfaceView.notes), e.g. GitHub's GH_PAT-vs-denylist quirk. */
  readonly notes?: string[]
}) {
  const commands = install?.commands
  const hasCommands = commands !== undefined && Object.keys(commands).length > 0

  return (
    <div className="flex flex-col gap-3">
      {hasCommands && (
        <div className="flex flex-col gap-2">
          <span
            style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}
          >
            Install it yourself
          </span>
          <ul className="flex flex-col gap-1.5 list-none m-0 p-0">
            {Object.entries(commands).map(([platform, command]) => (
              <li key={platform} className="flex items-center gap-2 flex-wrap">
                <span
                  style={{
                    fontSize: "var(--text-caption)",
                    color: "var(--gray-700)",
                    minWidth: "9em",
                  }}
                >
                  {OS_LABELS[platform] ?? platform}
                </span>
                <MonoCode>{command}</MonoCode>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SandboxBoundaryNote />

      {install?.verifyCmd !== undefined && (
        <div className="flex items-center gap-2 flex-wrap">
          <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
            Check it's installed:
          </span>
          <MonoCode>{install.verifyCmd}</MonoCode>
          {install.minVersion !== undefined && (
            <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-600)" }}>
              (requires ≥ {install.minVersion})
            </span>
          )}
        </div>
      )}

      {notes !== undefined && notes.length > 0 && (
        <ul className="flex flex-col gap-1 list-none m-0 p-0">
          {notes.map((note) => (
            <li key={note} style={{ fontSize: "var(--text-caption)", color: "var(--gray-600)" }}>
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
