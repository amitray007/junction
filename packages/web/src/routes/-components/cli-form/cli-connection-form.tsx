// SPDX-License-Identifier: AGPL-3.0-only
// CliConnectionForm — the guided CLI descriptor form: a list of tool cards
// (accordion, one open by default, at least one tool required) + a collapsed
// connection-level credentialEnvVar disclosure.

import { useState } from "react"
import { Field, Input, Tabs, TabsList, TabsTrigger } from "../../../ui/index.js"
import { ToolCardList } from "../tool-card-list.js"
// credentialEnvVarError (format + inc-41 JUNCTION_/interpreter denylist) lives
// in ./credential-env-var.ts — a neutral module both this form and
// full-access-panel import DOWN into, breaking the form ↔ panel import cycle.
import { credentialEnvVarError } from "./credential-env-var.js"
import { FullAccessPanel } from "./full-access-panel.js"
import { ToolCard } from "./tool-card.js"
import type { CliAccessMode, CliConnectionFormState } from "./types.js"
import { emptyTool } from "./types.js"

// Re-exported for existing importers that referenced it from this module.
export { credentialEnvVarError } from "./credential-env-var.js"

interface CliConnectionFormProps {
  readonly connection: CliConnectionFormState
  readonly onChange: (connection: CliConnectionFormState) => void
  readonly toolErrors?: Record<number, Record<string, string>>
}

export function CliConnectionForm({ connection, onChange, toolErrors }: CliConnectionFormProps) {
  const [credentialExpanded, setCredentialExpanded] = useState(connection.credentialEnvVar !== "")

  const envError = credentialEnvVarError(connection.credentialEnvVar)

  return (
    <div className="flex flex-col gap-4">
      <Field id="cli-access-mode" label="Access">
        <Tabs
          value={connection.mode}
          onValueChange={(v) => onChange({ ...connection, mode: v as CliAccessMode })}
        >
          <TabsList id="cli-access-mode">
            <TabsTrigger value="declared">Declared commands</TabsTrigger>
            <TabsTrigger value="full-access">Full CLI access</TabsTrigger>
          </TabsList>
        </Tabs>
      </Field>

      {connection.mode === "full-access" ? (
        <FullAccessPanel
          fullAccess={connection.fullAccess}
          onChange={(fullAccess) => onChange({ ...connection, fullAccess })}
        />
      ) : (
        <>
          <ToolCardList
            tools={connection.tools}
            onChange={(tools) => onChange({ ...connection, tools })}
            toolErrors={toolErrors}
            makeTool={emptyTool}
            addLabel="Add Tool"
            renderCard={(props) => <ToolCard key={props.tool.key} {...props} />}
          />

          <div
            className="rounded-[var(--radius-6)] border"
            style={{ borderColor: "var(--alpha-400)" }}
          >
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-left"
              onClick={() => setCredentialExpanded((v) => !v)}
              aria-expanded={credentialExpanded}
            >
              <span
                style={{
                  fontSize: "var(--text-label)",
                  fontWeight: 500,
                  color: "var(--gray-1000)",
                }}
              >
                Credential Env Var
              </span>
              <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
                {connection.credentialEnvVar || "none"}
              </span>
            </button>
            {credentialExpanded && (
              <div className="px-3 pb-3 pt-1">
                <Field
                  id="cli-credential-env-var"
                  label="Env Var Name"
                  description="Optional — the env var name the bound credential's secret is injected under. Empty = no credential injected."
                  error={envError}
                >
                  <Input
                    id="cli-credential-env-var"
                    placeholder="e.g. GH_PAT"
                    value={connection.credentialEnvVar}
                    onChange={(e) => onChange({ ...connection, credentialEnvVar: e.target.value })}
                    hasError={!!envError}
                  />
                </Field>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
