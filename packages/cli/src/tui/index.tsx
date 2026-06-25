// SPDX-License-Identifier: AGPL-3.0-only
// TUI launcher — renders the Ink dashboard and waits until the user quits.
// This module is dynamically imported from index.ts so that ink + react are
// only loaded when the interactive TUI is actually launched (lazy-load perf rule).

import { getPaths } from "@junction/core"
import { render } from "ink"
import { App } from "./App.js"
import { loadDashboardSnapshot } from "./data.js"

/**
 * Launch the full-screen Ink dashboard. Resolves when the user quits (q / Ctrl-C).
 * Never calls process.exit() — exit is handled by Ink's useApp().exit().
 */
export async function launchDashboard(): Promise<void> {
  const paths = getPaths()

  const snapshotResult = await loadDashboardSnapshot(paths)
  if (snapshotResult.isErr()) {
    // Can't load data — report and fall through (let the caller handle exit)
    process.stderr.write(
      `junction: failed to load dashboard data: ${snapshotResult.error.message}\n`,
    )
    return
  }

  const reload = async () => {
    const r = await loadDashboardSnapshot(paths)
    return r.isOk() ? r.value : snapshotResult.value
  }

  const instance = render(<App snapshot={snapshotResult.value} onReload={reload} />)

  await instance.waitUntilExit()
}
