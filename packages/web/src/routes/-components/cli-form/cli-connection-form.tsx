// SPDX-License-Identifier: AGPL-3.0-only
// CliConnectionForm — the guided CLI descriptor form: a list of tool cards
// (accordion, one open by default, at least one tool required) + a collapsed
// connection-level credentialEnvVar disclosure.

import { useState } from "react"
import { Field, Input } from "../../../ui/index.js"
import { ToolCardList } from "../tool-card-list.js"
import { ToolCard } from "./tool-card.js"
import type { CliConnectionFormState } from "./types.js"
import { emptyTool } from "./types.js"

const RESERVED_SUFFIX_RE = /_TOKEN$|_SECRET$|_KEY$/
const RESERVED_EXACT = new Set(["JUNCTION_MASTER_KEY", "JUNCTION_MASTER_KEY_FILE"])
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

/** Validate a credentialEnvVar value — mirrors CliConnectionSchema's format + denylist. */
export function credentialEnvVarError(name: string): string | undefined {
  if (name === "") return undefined
  if (!ENV_NAME_RE.test(name)) {
    return "Must be a valid env-var name (A-Z, 0-9, _; starts with A-Z or _)"
  }
  if (RESERVED_SUFFIX_RE.test(name) || RESERVED_EXACT.has(name)) {
    return "Reserved name — use GH_PAT, API_AUTH, or similar instead"
  }
  return undefined
}

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
      <ToolCardList
        tools={connection.tools}
        onChange={(tools) => onChange({ ...connection, tools })}
        toolErrors={toolErrors}
        makeTool={emptyTool}
        addLabel="Add Tool"
        renderCard={(props) => <ToolCard key={props.tool.key} {...props} />}
      />

      <div className="rounded-[var(--radius-6)] border" style={{ borderColor: "var(--alpha-400)" }}>
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-left"
          onClick={() => setCredentialExpanded((v) => !v)}
          aria-expanded={credentialExpanded}
        >
          <span
            style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}
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
    </div>
  )
}
