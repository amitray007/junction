// SPDX-License-Identifier: AGPL-3.0-only
// openInBrowser — open a URL in the system default browser. Not OAuth-specific
// (originally the `junction web` command's private helper); extracted to core
// at the rule-of-three point: `junction web`, the OAuth browser connect flow,
// and the OAuth device-code flow all need it (inc 29).
//
// Uses node:child_process spawn — NOT node:http/https, so this stays inside
// core's "no HTTP" boundary (enforced by the core-not-http depcruise rule).

// nosemgrep: no-child-process-outside-sandbox -- opens the system default browser via a fixed OS binary + a validated URL arg, never a user-controlled command string (see file header)
import { spawn } from "node:child_process"

/** Open a URL in the system default browser. No new dependency. */
export function openInBrowser(url: string): void {
  let cmd: string
  let cmdArgs: string[]
  if (process.platform === "darwin") {
    cmd = "open"
    cmdArgs = [url]
  } else if (process.platform === "win32") {
    cmd = "cmd"
    cmdArgs = ["/c", "start", url]
  } else {
    cmd = "xdg-open"
    cmdArgs = [url]
  }
  spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref()
}
