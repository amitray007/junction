// SPDX-License-Identifier: AGPL-3.0-only
// HttpToolCard — one operator-declared REST request-tool: name/description/
// method/path + a live path↔param mismatch hint + the params panel + an
// optional "Advanced" disclosure (responseHint, timeoutMs). Mirrors
// cli-form/tool-card.tsx's card/accordion structure; simpler (no argv preview,
// no sandbox policy panel — HTTP has neither).

import { useState } from "react"
import {
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../ui/index.js"
import { ToolCardShell } from "../tool-card-shell.js"
import { HttpParamsPanel } from "./http-params-panel.js"
import type { HttpMethod, HttpToolFormState } from "./types.js"

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]

const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g

/** The set of {name} placeholders found in a path template (order of first appearance). */
export function pathPlaceholders(path: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const m of path.matchAll(PLACEHOLDER_RE)) {
    const name = m[1]
    if (name !== undefined && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

interface HttpToolCardProps {
  readonly tool: HttpToolFormState
  readonly index: number
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onChange: (tool: HttpToolFormState) => void
  readonly onRemove: () => void
  readonly canRemove: boolean
  readonly errors?: Record<string, string>
}

export function HttpToolCard({
  tool,
  index,
  expanded,
  onToggle,
  onChange,
  onRemove,
  canRemove,
  errors,
}: HttpToolCardProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const placeholders = pathPlaceholders(tool.path)
  const pathParamNames = new Set(tool.params.filter((p) => p.in === "path").map((p) => p.name))
  const missingPathParams = placeholders.filter((name) => !pathParamNames.has(name))
  const orphanedPathParams = tool.params.filter(
    (p) => p.in === "path" && !placeholders.includes(p.name),
  )

  return (
    <ToolCardShell
      name={tool.name}
      index={index}
      summary={`${tool.method} ${tool.path.trim() || "(no path yet)"}`}
      expanded={expanded}
      onToggle={onToggle}
      onRemove={onRemove}
      canRemove={canRemove}
      removeDisabledTitle="An HTTP platform needs at least one tool"
    >
      <div className="flex gap-4">
        <Field
          id={`http-tool-${tool.key}-name`}
          label="Name"
          error={errors?.name}
          className="flex-1"
        >
          <Input
            id={`http-tool-${tool.key}-name`}
            placeholder="e.g. listIssues"
            value={tool.name}
            onChange={(e) => onChange({ ...tool, name: e.target.value })}
            hasError={!!errors?.name}
          />
        </Field>
        <Field
          id={`http-tool-${tool.key}-description`}
          label="Description"
          error={errors?.description}
          className="flex-1"
          description="Required — the agent's only knowledge of what this tool does."
        >
          <Input
            id={`http-tool-${tool.key}-description`}
            value={tool.description}
            onChange={(e) => onChange({ ...tool, description: e.target.value })}
            hasError={!!errors?.description}
            aria-required="true"
          />
        </Field>
      </div>

      <div className="flex gap-4">
        <Field id={`http-tool-${tool.key}-method`} label="Method">
          <Select
            value={tool.method}
            onValueChange={(v) => onChange({ ...tool, method: v as HttpMethod })}
          >
            <SelectTrigger id={`http-tool-${tool.key}-method`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HTTP_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          id={`http-tool-${tool.key}-path`}
          label="Path"
          className="flex-1"
          description="e.g. /repos/{owner}/{repo}/issues — {placeholders} bind to path params below."
          error={errors?.path}
        >
          <Input
            id={`http-tool-${tool.key}-path`}
            placeholder="/repos/{owner}/{repo}/issues"
            value={tool.path}
            onChange={(e) => onChange({ ...tool, path: e.target.value })}
            hasError={!!errors?.path}
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </Field>
      </div>

      {orphanedPathParams.length > 0 && (
        <div
          className="flex items-center gap-2 rounded-[var(--radius-6)] border px-3 py-2"
          style={{ borderColor: "var(--status-warning-fg)" }}
        >
          <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-900)" }}>
            {orphanedPathParams.length === 1 ? "Path param " : "Path params "}
            {orphanedPathParams.map((p) => `{${p.name}}`).join(", ")} declared but not referenced as
            a <code style={{ fontFamily: "var(--font-mono)" }}>{"{placeholder}"}</code> in the path.
          </span>
        </div>
      )}

      <HttpParamsPanel
        params={tool.params}
        onChange={(params) => onChange({ ...tool, params })}
        missingPathParams={missingPathParams}
      />

      <div className="rounded-[var(--radius-6)] border" style={{ borderColor: "var(--alpha-400)" }}>
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-left"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
        >
          <span
            style={{
              fontSize: "var(--text-label)",
              fontWeight: 500,
              color: "var(--gray-1000)",
            }}
          >
            Advanced
          </span>
          <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
            {tool.timeoutMs ? `${tool.timeoutMs}ms` : "default timeout"}
          </span>
        </button>
        {advancedOpen && (
          <div className="flex flex-col gap-4 px-3 pb-3 pt-1">
            <Field
              id={`http-tool-${tool.key}-response-hint`}
              label="Response Hint"
              description="Optional hint about the response shape, forwarded to the agent."
            >
              <Input
                id={`http-tool-${tool.key}-response-hint`}
                value={tool.responseHint}
                onChange={(e) => onChange({ ...tool, responseHint: e.target.value })}
              />
            </Field>
            <Field
              id={`http-tool-${tool.key}-timeout`}
              label="Timeout (ms)"
              description="Per-tool request timeout override. Max 120000 (2 minutes)."
            >
              <Input
                id={`http-tool-${tool.key}-timeout`}
                type="number"
                max={120_000}
                value={tool.timeoutMs}
                onChange={(e) => onChange({ ...tool, timeoutMs: e.target.value })}
              />
            </Field>
          </div>
        )}
      </div>
    </ToolCardShell>
  )
}
