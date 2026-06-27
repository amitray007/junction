// SPDX-License-Identifier: AGPL-3.0-only
// Profiles list route with joined source metadata. No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { getProfiles, type ProfileMeta, type SourceMeta } from "../server/data.functions.js"

export const Route = createFileRoute("/profiles")({
  loader: () => getProfiles(),
  component: ProfilesPage,
})

function ProfilesPage() {
  const profiles = Route.useLoaderData()
  return (
    <div>
      <h1>Profiles</h1>
      {profiles.length === 0 ? (
        <p className="empty">
          No profiles yet. Use <code>junction profile create</code> to create one.
        </p>
      ) : (
        profiles.map((p: ProfileMeta) => (
          <div key={p.id} className="profile-card">
            <h2>{p.name}</h2>
            <p className="mcp-path">
              MCP endpoint: <code>{p.mcpEndpointPath}</code>
            </p>
            {p.sources.length === 0 ? (
              <p className="empty">No sources.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Namespace</th>
                    <th>Platform</th>
                    <th>Account</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {p.sources.map((s: SourceMeta) => (
                    <tr key={s.namespace}>
                      <td>
                        <code>{s.namespace}</code>
                      </td>
                      <td>
                        <code>{s.platform}</code>
                      </td>
                      <td>{s.credentialAccount}</td>
                      <td>{s.enabled ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))
      )}
    </div>
  )
}
