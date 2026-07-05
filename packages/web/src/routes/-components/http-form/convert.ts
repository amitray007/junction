// SPDX-License-Identifier: AGPL-3.0-only
// Conversion between the HTTP guided form's client state and the wire shapes:
// HttpConnectionFormState → HttpConnectionInput (submit), and the
// platform-detail DTO's httpTools/httpDefaultHeaders → HttpConnectionFormState
// (edit-mode pre-fill). Simpler than cli-form/convert.ts — no argv tokenizer,
// no sandbox policy: straight field copy both ways.

import type {
  HttpConnectionInput,
  HttpParamInput,
  HttpToolInput,
} from "../../../server/platform-mutations.functions.js"
import type {
  HttpConnectionFormState,
  HttpHeaderFormState,
  HttpParamFormState,
  HttpToolFormState,
} from "./types.js"
import { emptyHeaderRow, nextKey } from "./types.js"

// ---------------------------------------------------------------------------
// Form state → wire input (submit path)
// ---------------------------------------------------------------------------

/**
 * Parse a numeric form field, returning undefined for empty OR non-finite input.
 * `Number("abc")` is NaN and `JSON.stringify(NaN)` is `null` — sending `null`
 * would be a bad payload the schema can't cleanly reject; omitting the field
 * instead lets the boundary validator surface a proper error. (inc-30.7 CodeRabbit #513.)
 */
function finiteOrUndefined(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function toParamInput(param: HttpParamFormState): HttpParamInput {
  return {
    name: param.name.trim(),
    in: param.in,
    type: param.type,
    required: param.required,
    description: param.description.trim() || undefined,
    enum: param.type === "enum" ? param.enumValues : undefined,
    pattern: param.pattern.trim() || undefined,
    maxLength: finiteOrUndefined(param.maxLength),
  }
}

function toToolInput(tool: HttpToolFormState): HttpToolInput {
  return {
    name: tool.name.trim(),
    description: tool.description.trim(),
    method: tool.method,
    path: tool.path.trim(),
    params: tool.params.map(toParamInput),
    responseHint: tool.responseHint.trim() || undefined,
    timeoutMs: finiteOrUndefined(tool.timeoutMs),
  }
}

function toHeaderRecord(entries: HttpHeaderFormState[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const { key, value } of entries) {
    if (key.trim()) out[key.trim()] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function toHttpConnectionInput(
  state: HttpConnectionFormState,
): Omit<HttpConnectionInput, "auth"> {
  return {
    baseUrl: state.baseUrl.trim(),
    defaultHeaders: toHeaderRecord(state.defaultHeaders),
    tools: state.tools.map(toToolInput),
  }
}

// ---------------------------------------------------------------------------
// Platform-detail DTO → form state (edit-mode pre-fill)
// ---------------------------------------------------------------------------

export interface HttpToolDetailLike {
  name: string
  description: string
  method: HttpToolFormState["method"]
  path: string
  params: Array<{
    name: string
    in: HttpParamFormState["in"]
    type: HttpParamFormState["type"]
    required: boolean
    description?: string
    enum?: string[]
    pattern?: string
    maxLength?: number
  }>
  responseHint?: string
  timeoutMs?: number
}

function paramFromDetail(param: HttpToolDetailLike["params"][number]): HttpParamFormState {
  return {
    key: nextKey("param"),
    name: param.name,
    in: param.in,
    type: param.type,
    required: param.required,
    description: param.description ?? "",
    enumValues: param.enum ?? [],
    pattern: param.pattern ?? "",
    maxLength: param.maxLength !== undefined ? String(param.maxLength) : "",
  }
}

function toolFromDetail(tool: HttpToolDetailLike): HttpToolFormState {
  return {
    key: nextKey("tool"),
    name: tool.name,
    description: tool.description,
    method: tool.method,
    path: tool.path,
    params: tool.params.map(paramFromDetail),
    responseHint: tool.responseHint ?? "",
    timeoutMs: tool.timeoutMs !== undefined ? String(tool.timeoutMs) : "",
  }
}

export function httpConnectionFromDetail(detail: {
  baseUrl?: string
  httpDefaultHeaders?: Record<string, string>
  httpTools?: HttpToolDetailLike[]
}): HttpConnectionFormState {
  return {
    baseUrl: detail.baseUrl ?? "",
    defaultHeaders: Object.entries(detail.httpDefaultHeaders ?? {}).map(([key, value]) =>
      emptyHeaderRow(key, value),
    ),
    tools: (detail.httpTools ?? []).map(toolFromDetail),
  }
}
