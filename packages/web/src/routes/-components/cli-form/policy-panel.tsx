// SPDX-License-Identifier: AGPL-3.0-only
// PolicyPanel — the sandbox permissions sub-form for one CLI tool.
// Collapsed by default; summary reads in words ("sandboxed · reads N · no network · Ns").

import { Plus, X } from "lucide-react"
import { useState } from "react"
import { Button, Field, Input } from "../../../ui/index.js"
import type { CliEnvAllowFormState, CliPathFormState, CliPolicyFormState } from "./types.js"
import { emptyEnvAllowRow, emptyPathRow } from "./types.js"

interface PolicyPanelProps {
  readonly toolKey: string
  readonly policy: CliPolicyFormState
  readonly onChange: (policy: CliPolicyFormState) => void
}

function summarize(policy: CliPolicyFormState): string {
  const reads = policy.readPaths.length
  const net =
    policy.network.mode === "denied" ? "no network" : `${policy.network.hosts.length} host(s)`
  const timeout = Number(policy.timeoutMs) || 0
  return `sandboxed · reads ${reads} · ${net} · ${Math.round(timeout / 1000)}s`
}

function PathRepeater({
  label,
  paths,
  onChange,
}: {
  readonly label: string
  readonly paths: CliPathFormState[]
  readonly onChange: (paths: CliPathFormState[]) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
        {label}
      </span>
      {paths.map((p, i) => (
        <div key={p.id} className="flex gap-2">
          <Input
            value={p.value}
            placeholder="/absolute/path"
            onChange={(e) => {
              const next = [...paths]
              next[i] = { ...p, value: e.target.value }
              onChange(next)
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${label.toLowerCase()} path`}
            onClick={() => onChange(paths.filter((_, idx) => idx !== i))}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onChange([...paths, emptyPathRow()])}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add Path
      </Button>
    </div>
  )
}

export function PolicyPanel({ toolKey, policy, onChange }: PolicyPanelProps) {
  const [expanded, setExpanded] = useState(false)

  function set<K extends keyof CliPolicyFormState>(key: K, value: CliPolicyFormState[K]) {
    onChange({ ...policy, [key]: value })
  }

  return (
    <div className="rounded-[var(--radius-6)] border" style={{ borderColor: "var(--alpha-400)" }}>
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
          Permissions
        </span>
        <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
          {summarize(policy)}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-4 px-3 pb-3 pt-1">
          <Field
            id={`${toolKey}-cwd`}
            label="Working Directory"
            description="Must be an absolute path."
          >
            <Input
              id={`${toolKey}-cwd`}
              placeholder="/absolute/path"
              value={policy.cwd}
              onChange={(e) => set("cwd", e.target.value)}
            />
          </Field>

          <PathRepeater
            label="Read Paths"
            paths={policy.readPaths}
            onChange={(readPaths) => set("readPaths", readPaths)}
          />
          <PathRepeater
            label="Write Paths"
            paths={policy.writePaths}
            onChange={(writePaths) => set("writePaths", writePaths)}
          />

          <fieldset className="flex flex-col gap-2">
            <legend
              style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}
            >
              Network
            </legend>
            <label className="flex items-center gap-2" style={{ fontSize: "var(--text-body)" }}>
              <input
                type="radio"
                name={`${toolKey}-network`}
                checked={policy.network.mode === "denied"}
                onChange={() => set("network", { mode: "denied" })}
              />
              Denied
            </label>
            <label className="flex items-center gap-2" style={{ fontSize: "var(--text-body)" }}>
              <input
                type="radio"
                name={`${toolKey}-network`}
                checked={policy.network.mode === "allow"}
                onChange={() => set("network", { mode: "allow", hosts: [] })}
              />
              Allow Hosts
            </label>
            {policy.network.mode === "allow" && (
              <PathRepeater
                label="Allowed host[:port]"
                paths={policy.network.hosts}
                onChange={(hosts) => set("network", { mode: "allow", hosts })}
              />
            )}
          </fieldset>

          <Field
            id={`${toolKey}-timeout`}
            label="Timeout (ms)"
            description="Hard kill ceiling. Max 600000 (10 minutes)."
          >
            <Input
              id={`${toolKey}-timeout`}
              type="number"
              max={600_000}
              value={policy.timeoutMs}
              onChange={(e) => set("timeoutMs", e.target.value)}
            />
          </Field>

          <EnvAllowRepeater
            entries={policy.envAllow}
            onChange={(envAllow) => set("envAllow", envAllow)}
          />
        </div>
      )}
    </div>
  )
}

function EnvAllowRepeater({
  entries,
  onChange,
}: {
  readonly entries: CliEnvAllowFormState[]
  readonly onChange: (entries: CliEnvAllowFormState[]) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="flex items-center justify-between text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
          Static Env Vars
        </span>
        <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
          {entries.length} set
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-2">
          {entries.map((entry, i) => (
            <div key={entry.id} className="flex gap-2">
              <Input
                placeholder="KEY"
                value={entry.key}
                onChange={(e) => {
                  const next = [...entries]
                  next[i] = { ...entry, key: e.target.value }
                  onChange(next)
                }}
              />
              <Input
                placeholder="value"
                value={entry.value}
                onChange={(e) => {
                  const next = [...entries]
                  next[i] = { ...entry, value: e.target.value }
                  onChange(next)
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove env var"
                onClick={() => onChange(entries.filter((_, idx) => idx !== i))}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onChange([...entries, emptyEnvAllowRow()])}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add Variable
          </Button>
        </div>
      )}
    </div>
  )
}
