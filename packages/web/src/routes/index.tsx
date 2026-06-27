// SPDX-License-Identifier: AGPL-3.0-only
// Dashboard route — counts + status from readDashboard() server fn.
// No @junction/core import here; data flows exclusively through server functions.

import { createFileRoute } from "@tanstack/react-router"
import { getDashboard } from "../server/data.functions.js"

export const Route = createFileRoute("/")({
  loader: () => getDashboard(),
  component: DashboardPage,
})

function DashboardPage() {
  const data = Route.useLoaderData()
  return (
    <div>
      <h1>Dashboard</h1>
      <div className="card-grid">
        <div className="card">
          <div className="card-value">{data.counts.platforms}</div>
          <div className="card-label">Platforms</div>
        </div>
        <div className="card">
          <div className="card-value">{data.counts.credentials}</div>
          <div className="card-label">Credentials</div>
        </div>
        <div className="card">
          <div className="card-value">{data.counts.profiles}</div>
          <div className="card-label">Profiles</div>
        </div>
      </div>
      <dl className="status-list">
        <dt>Home</dt>
        <dd>{data.home}</dd>
        <dt>Initialized</dt>
        <dd>{data.initialized ? "Yes" : "No"}</dd>
        <dt>Credential store</dt>
        <dd>{data.credentialStore}</dd>
        <dt>Sandbox</dt>
        <dd>{data.sandbox}</dd>
      </dl>
    </div>
  )
}
