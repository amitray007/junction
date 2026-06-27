// SPDX-License-Identifier: AGPL-3.0-only
// Platforms list route. No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { getPlatforms, type PlatformMeta } from "../server/data.functions.js"

export const Route = createFileRoute("/platforms")({
  loader: () => getPlatforms(),
  component: PlatformsPage,
})

function PlatformsPage() {
  const platforms = Route.useLoaderData()
  return (
    <div>
      <h1>Platforms</h1>
      {platforms.length === 0 ? (
        <p className="empty">
          No platforms yet. Use <code>junction platform add</code> to add one.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Kind</th>
              <th>Display name</th>
              <th>Base URL</th>
            </tr>
          </thead>
          <tbody>
            {platforms.map((p: PlatformMeta) => (
              <tr key={p.id}>
                <td>
                  <code>{p.id}</code>
                </td>
                <td>{p.kind}</td>
                <td>{p.displayName}</td>
                <td>{p.baseUrl ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
