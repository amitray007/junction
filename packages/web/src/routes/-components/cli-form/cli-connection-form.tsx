// SPDX-License-Identifier: AGPL-3.0-only
// CliConnectionForm — the guided CLI descriptor form: a list of tool cards
// (accordion, one open by default, at least one tool required) + a collapsed
// connection-level credentialEnvVar disclosure.

import { useState } from "react"
import { Field, Input, Tabs, TabsList, TabsTrigger } from "../../../ui/index.js"
import { ToolCardList } from "../tool-card-list.js"
import { FullAccessPanel } from "./full-access-panel.js"
import { ToolCard } from "./tool-card.js"
import type { CliAccessMode, CliConnectionFormState } from "./types.js"
import { emptyTool } from "./types.js"

// inc 41 (Fable ruling): the _TOKEN/_SECRET/_KEY suffix heuristic was DROPPED
// (it blocked GH_TOKEN — the only var `gh` reads — for no real security
// gain) and replaced with a JUNCTION_ prefix reservation + the
// dynamic-linker/interpreter denylist class. This is a CLIENT component
// (no .server.ts) so it cannot import @junction/core (would pull
// better-sqlite3/keyring into the client bundle — see docs/rules/web.md
// "server-only-core boundary") — the predicate is deliberately duplicated
// here, mirroring sandbox/env-denylist.ts's isJunctionReservedEnvKey /
// isInterpreterDenylistedEnvKey. Keep in lock-step with those.
const INTERPRETER_ENV_DENYLIST = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "NODE_OPTIONS",
])
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

function isDenylistedCredentialEnvVar(name: string): boolean {
  if (name.startsWith("JUNCTION_")) return true
  const upper = name.toUpperCase()
  return INTERPRETER_ENV_DENYLIST.has(upper) || upper.startsWith("DYLD_")
}

/** Validate a credentialEnvVar value — mirrors CliConnectionSchema's format + denylist. */
export function credentialEnvVarError(name: string): string | undefined {
  if (name === "") return undefined
  if (!ENV_NAME_RE.test(name)) {
    return "Must be a valid env-var name (A-Z, 0-9, _; starts with A-Z or _)"
  }
  if (isDenylistedCredentialEnvVar(name)) {
    return "Reserved name — JUNCTION_-prefixed and dynamic-linker/interpreter names (LD_PRELOAD, DYLD_*, NODE_OPTIONS) are not allowed"
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
