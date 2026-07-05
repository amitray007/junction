// SPDX-License-Identifier: AGPL-3.0-only
// Shared client-side form-state types for the HTTP guided form.
// Mirrors packages/web/src/server/platform-mutations.server.ts's
// HttpConnectionInput exactly (that's what gets sent over the wire) plus a
// client-only `key` for stable React keys across add/remove/reorder (never
// sent to the server). Simpler than cli-form/types.ts — no command-line
// tokenizer, no sandbox policy: HTTP has no argv, no sandbox.

export type HttpParamLocation = "path" | "query" | "header" | "body"
export type HttpParamType = "string" | "number" | "boolean" | "enum"
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"

export interface HttpParamFormState {
  /** Client-only stable key — not sent to the server. */
  readonly key: string
  name: string
  in: HttpParamLocation
  type: HttpParamType
  required: boolean
  description: string
  enumValues: string[]
  pattern: string
  maxLength: string
}

export interface HttpToolFormState {
  readonly key: string
  name: string
  /** REQUIRED — this is the agent's only knowledge of what the tool does. */
  description: string
  method: HttpMethod
  path: string
  params: HttpParamFormState[]
  responseHint: string
  timeoutMs: string
}

/** One default-header row — connection-level, added to every outbound request. */
export interface HttpHeaderFormState {
  readonly id: string
  key: string
  value: string
}

export interface HttpConnectionFormState {
  baseUrl: string
  defaultHeaders: HttpHeaderFormState[]
  tools: HttpToolFormState[]
}

let keyCounter = 0
/** Client-only unique key generator for list items (tools/params/headers) — not persisted. */
export function nextKey(prefix: string): string {
  keyCounter += 1
  return `${prefix}-${keyCounter}`
}

export function emptyHeaderRow(key = "", value = ""): HttpHeaderFormState {
  return { id: nextKey("header"), key, value }
}

export function emptyHttpParam(): HttpParamFormState {
  return {
    key: nextKey("param"),
    name: "",
    in: "query",
    type: "string",
    required: false,
    description: "",
    enumValues: [],
    pattern: "",
    maxLength: "",
  }
}

export function emptyHttpTool(): HttpToolFormState {
  return {
    key: nextKey("tool"),
    name: "",
    description: "",
    method: "GET",
    path: "",
    params: [],
    responseHint: "",
    timeoutMs: "",
  }
}

export function emptyHttpConnection(): HttpConnectionFormState {
  return { baseUrl: "", defaultHeaders: [], tools: [emptyHttpTool()] }
}
