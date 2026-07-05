// SPDX-License-Identifier: AGPL-3.0-only
// HttpParamsPanel — one row per declared param on an HTTP request-tool. Mirrors
// cli-form/args-panel.tsx's ArgRow layout EXACTLY (same rounded-bordered row,
// same Field/Select/Switch primitives, same constraints disclosure) — the one
// new element is the location Select (path/query/header/body), styled
// identically to the type Select beside it.

import { X } from "lucide-react"
import { Field, Input } from "../../../ui/index.js"
import { LabeledSelect, RequiredToggle } from "../labeled-select.js"
import { ValueConstraintFields } from "../value-constraint-fields.js"
import type { HttpParamFormState, HttpParamLocation, HttpParamType } from "./types.js"
import { emptyHttpParam } from "./types.js"

const PARAM_LOCATIONS: readonly HttpParamLocation[] = ["path", "query", "header", "body"]
const PARAM_TYPES: readonly HttpParamType[] = ["string", "number", "boolean", "enum"]

interface HttpParamsPanelProps {
  readonly params: HttpParamFormState[]
  readonly onChange: (params: HttpParamFormState[]) => void
  /** Path placeholder names ({name}) that don't have a matching in:"path" param — from the tool card. */
  readonly missingPathParams?: string[]
}

export function HttpParamsPanel({
  params,
  onChange,
  missingPathParams = [],
}: HttpParamsPanelProps) {
  function addParam() {
    onChange([...params, emptyHttpParam()])
  }

  function updateParam(key: string, patch: Partial<HttpParamFormState>) {
    onChange(params.map((p) => (p.key === key ? { ...p, ...patch } : p)))
  }

  function removeParam(key: string) {
    onChange(params.filter((p) => p.key !== key))
  }

  function declareMissingPathParam(name: string) {
    onChange([...params, { ...emptyHttpParam(), name, in: "path", required: true }])
  }

  return (
    <div className="flex flex-col gap-2">
      <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
        Params
      </span>

      {missingPathParams.map((name) => (
        <div
          key={name}
          className="flex items-center justify-between rounded-[var(--radius-6)] border px-3 py-2"
          style={{ borderColor: "var(--status-warning-fg)" }}
        >
          <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-900)" }}>
            <code style={{ fontFamily: "var(--font-mono)" }}>{`{${name}}`}</code> is used in the
            path but not declared as a path param.
          </span>
          <button
            type="button"
            onClick={() => declareMissingPathParam(name)}
            style={{ fontSize: "var(--text-caption)", color: "var(--blue-text)" }}
          >
            Declare it
          </button>
        </div>
      ))}

      {params.map((param) => (
        <ParamRow
          key={param.key}
          param={param}
          onChange={(patch) => updateParam(param.key, patch)}
          onRemove={() => removeParam(param.key)}
        />
      ))}

      <button
        type="button"
        className="self-start"
        onClick={addParam}
        style={{ fontSize: "var(--text-caption)", color: "var(--blue-text)" }}
      >
        + Add Param
      </button>
    </div>
  )
}

function ParamRow({
  param,
  onChange,
  onRemove,
}: {
  readonly param: HttpParamFormState
  readonly onChange: (patch: Partial<HttpParamFormState>) => void
  readonly onRemove: () => void
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-6)] border p-3"
      style={{ borderColor: "var(--alpha-400)" }}
    >
      <div className="flex items-center justify-between">
        <Field id={`param-${param.key}-name`} label="Name" className="flex-1">
          <Input
            id={`param-${param.key}-name`}
            placeholder="e.g. owner"
            value={param.name}
            onChange={(e) => onChange({ name: e.target.value })}
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </Field>
        <button
          type="button"
          aria-label={`Remove param ${param.name || "(unnamed)"}`}
          onClick={onRemove}
          className="ml-2 mt-5"
        >
          <X className="h-4 w-4" aria-hidden="true" style={{ color: "var(--gray-700)" }} />
        </button>
      </div>

      <Field id={`param-${param.key}-description`} label="Description">
        <Input
          id={`param-${param.key}-description`}
          value={param.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Field>

      <div className="flex items-center gap-4">
        <LabeledSelect
          id={`param-${param.key}-in`}
          label="Location"
          className="flex-1"
          value={param.in}
          options={PARAM_LOCATIONS}
          onValueChange={(v) => onChange({ in: v as HttpParamLocation })}
        />

        <LabeledSelect
          id={`param-${param.key}-type`}
          label="Type"
          className="flex-1"
          value={param.type}
          options={PARAM_TYPES}
          onValueChange={(v) => onChange({ type: v as HttpParamType })}
        />

        <RequiredToggle
          checked={param.required}
          onCheckedChange={(v) => onChange({ required: v })}
        />
      </div>

      <ValueConstraintFields
        idPrefix={`param-${param.key}`}
        type={param.type}
        enumValues={param.enumValues}
        pattern={param.pattern}
        maxLength={param.maxLength}
        onChange={onChange}
      />
    </div>
  )
}
