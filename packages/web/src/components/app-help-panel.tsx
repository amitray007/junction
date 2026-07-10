// SPDX-License-Identifier: AGPL-3.0-only
// App help panel (increment 36, Component 3) — pure render of AppDetail.app.help
// (packages/core/src/apps/catalog-schema.ts AppHelpSchema), already flowing
// end-to-end through readAppDetail (data.server.ts:591/717). NO server-fn, NO
// DTO change — this is presentation only over data already at the page.
//
// Renders: homepage/statusPage as external links (rel=noopener), category as
// chips, description + agentGuidance as prose, authSetup as a labeled block,
// oauthApp.registerUrl as a "register your OAuth app" link. Metadata-only —
// `help` never carries a secret/token/build recipe (AppHelpSchema has no such
// field), so this component has nothing to leak by construction.
//
// Renders nothing (returns null) when `help` is undefined — every field is
// optional, so each block independently no-ops when absent (never a whole-panel
// crash on a thin/partially-authored app).

import { ExternalLink } from "lucide-react"
import type { AppHelp } from "../server/data.functions.js"
import { MonoCode } from "../ui/code.js"

function ExternalLinkRow({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5"
      style={{ fontSize: "var(--text-body)", color: "var(--blue-text)" }}
    >
      {label}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  )
}

function AuthSetupBlock({ authSetup }: { readonly authSetup: NonNullable<AppHelp["authSetup"]> }) {
  const rows: { label: string; value: string }[] = []
  if (authSetup.interactive !== undefined)
    rows.push({ label: "Interactive", value: authSetup.interactive })
  if (authSetup.env !== undefined) rows.push({ label: "Env var", value: authSetup.env })
  if (authSetup.configPath !== undefined)
    rows.push({ label: "Config path", value: authSetup.configPath })
  if (rows.length === 0) return null

  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-6)] p-3"
      style={{ border: "1px solid var(--alpha-200)", backgroundColor: "var(--bg-200)" }}
    >
      <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
        Setting the credential yourself
      </span>
      <dl className="flex flex-col gap-1.5 m-0">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-2 flex-wrap">
            <dt style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              {row.label}
            </dt>
            <dd className="m-0">
              <MonoCode>{row.value}</MonoCode>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function AppHelpPanel({ help }: { readonly help: AppHelp | undefined }) {
  if (help === undefined) return null

  const hasLinks = help.homepage !== undefined || help.statusPage !== undefined
  const hasCategory = help.category !== undefined && help.category.length > 0
  const hasProse = help.description !== undefined || help.agentGuidance !== undefined
  const hasAuthSetup = help.authSetup !== undefined
  const hasOAuthApp = help.oauthApp?.registerUrl !== undefined

  if (!hasLinks && !hasCategory && !hasProse && !hasAuthSetup && !hasOAuthApp) return null

  return (
    <section className="flex flex-col gap-3" aria-label="About this app">
      {hasCategory && (
        <ul className="flex flex-wrap gap-1.5 list-none m-0 p-0">
          {(help.category ?? []).map((c) => (
            <li key={c}>
              <span
                style={{
                  fontSize: "var(--text-caption)",
                  color: "var(--gray-700)",
                  border: "1px solid var(--alpha-400)",
                  borderRadius: "var(--radius-6)",
                  padding: "2px 8px",
                }}
              >
                {c}
              </span>
            </li>
          ))}
        </ul>
      )}

      {help.description !== undefined && (
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-900)", margin: 0 }}>
          {help.description}
        </p>
      )}

      {help.agentGuidance !== undefined && (
        <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
          <span style={{ fontWeight: 500, color: "var(--gray-900)" }}>For agents: </span>
          {help.agentGuidance}
        </p>
      )}

      {hasLinks && (
        <div className="flex items-center gap-4 flex-wrap">
          {help.homepage !== undefined && <ExternalLinkRow href={help.homepage} label="Homepage" />}
          {help.statusPage !== undefined && (
            <ExternalLinkRow href={help.statusPage} label="Status page" />
          )}
        </div>
      )}

      {help.authSetup !== undefined && <AuthSetupBlock authSetup={help.authSetup} />}

      {hasOAuthApp && help.oauthApp?.registerUrl !== undefined && (
        <ExternalLinkRow href={help.oauthApp.registerUrl} label="Register your OAuth app" />
      )}
    </section>
  )
}
