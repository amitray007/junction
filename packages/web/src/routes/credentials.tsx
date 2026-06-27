// SPDX-License-Identifier: AGPL-3.0-only
// Credentials list route — metadata only, never secret or secretRef.
// No @junction/core import.

import { createFileRoute } from "@tanstack/react-router"
import { type CredentialMeta, getCredentials } from "../server/data.functions.js"

export const Route = createFileRoute("/credentials")({
  loader: () => getCredentials(),
  component: CredentialsPage,
})

function CredentialsPage() {
  const credentials = Route.useLoaderData()
  return (
    <div>
      <h1>Credentials</h1>
      {credentials.length === 0 ? (
        <p className="empty">
          No credentials yet. Use <code>junction credential add</code> to add one.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Platform</th>
              <th>Account</th>
              <th>Kind</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((c: CredentialMeta) => (
              <tr key={c.id}>
                <td>
                  <code>{c.id}</code>
                </td>
                <td>
                  <code>{c.platformId}</code>
                </td>
                <td>{c.account}</td>
                <td>{c.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
