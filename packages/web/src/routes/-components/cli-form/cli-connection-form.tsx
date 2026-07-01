// SPDX-License-Identifier: AGPL-3.0-only
// CliConnectionForm — the guided CLI descriptor form: a list of tool cards
// (accordion, one open by default, at least one tool required) + a collapsed
// connection-level credentialEnvVar disclosure.

import { Plus } from "lucide-react"
import { useState } from "react"
import { Button, Field, Input } from "../../../ui/index.js"
import { ToolCard } from "./tool-card.js"
import type { CliConnectionFormState, CliToolFormState } from "./types.js"
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
  const [expandedKey, setExpandedKey] = useState<string | undefined>(connection.tools[0]?.key)
  const [credentialExpanded, setCredentialExpanded] = useState(connection.credentialEnvVar !== "")

  function updateTool(key: string, tool: CliToolFormState) {
    onChange({
      ...connection,
      tools: connection.tools.map((t) => (t.key === key ? tool : t)),
    })
  }

  function addTool() {
    const tool = emptyTool()
    onChange({ ...connection, tools: [...connection.tools, tool] })
    setExpandedKey(tool.key)
  }

  function removeTool(key: string) {
    if (connection.tools.length <= 1) return
    onChange({ ...connection, tools: connection.tools.filter((t) => t.key !== key) })
  }

  const envError = credentialEnvVarError(connection.credentialEnvVar)

  return (
    <div className="flex flex-col gap-4">
      {connection.tools.map((tool, i) => (
        <ToolCard
          key={tool.key}
          tool={tool}
          index={i}
          expanded={expandedKey === tool.key}
          onToggle={() => setExpandedKey((cur) => (cur === tool.key ? undefined : tool.key))}
          onChange={(next) => updateTool(tool.key, next)}
          onRemove={() => removeTool(tool.key)}
          canRemove={connection.tools.length > 1}
          errors={toolErrors?.[i]}
        />
      ))}

      <Button type="button" variant="secondary" size="sm" className="self-start" onClick={addTool}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add Tool
      </Button>

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
