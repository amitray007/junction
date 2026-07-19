// SPDX-License-Identifier: AGPL-3.0-only
// Shared client-side form-state types for the CLI guided form.
// Mirrors packages/web/src/server/platform-mutations.server.ts's CliConnectionInput
// exactly (that's what gets sent over the wire) plus a client-only `id` for stable
// React keys across add/remove/reorder (never sent to the server).

export type CliArgType = "string" | "number" | "boolean" | "enum" | "path"

export interface CliToolArgFormState {
  /** Client-only stable key — not sent to the server. */
  readonly key: string
  name: string
  description: string
  type: CliArgType
  required: boolean
  enumValues: string[]
  pattern: string
  maxLength: string
}

/** One path row in a PathRepeater (readPaths/writePaths/network.hosts) — `id` is a stable client-only React key. */
export interface CliPathFormState {
  readonly id: string
  value: string
}

export type CliNetworkFormState = { mode: "denied" } | { mode: "allow"; hosts: CliPathFormState[] }

/** One env-var row in the Static Env Vars repeater — `id` is a stable client-only React key. */
export interface CliEnvAllowFormState {
  readonly id: string
  key: string
  value: string
}

export interface CliPolicyFormState {
  cwd: string
  readPaths: CliPathFormState[]
  writePaths: CliPathFormState[]
  network: CliNetworkFormState
  timeoutMs: string
  envAllow: CliEnvAllowFormState[]
}

export interface CliToolFormState {
  readonly key: string
  name: string
  description: string
  commandLine: string
  args: CliToolArgFormState[]
  policy: CliPolicyFormState
  /** True when this tool's descriptor couldn't round-trip through the guided form (edit mode). */
  advanced: boolean
  /** The raw tool JSON — only meaningful when `advanced` is true (the JSON escape hatch). */
  rawJson: string
}

// ---------------------------------------------------------------------------
// Full CLI access sub-flow state (inc 41.4) — binary discovery + install.
// docs/specs/2026-07-16-cli-exploratory-mode.md §5 Q1/Q3/Q6.
// ---------------------------------------------------------------------------

export type CliAccessMode = "declared" | "full-access"

export interface CliBinaryCandidateState {
  path: string
  realpath: string
  version?: string
  source: "path" | "common-dir"
}

// ---------------------------------------------------------------------------
// Inline credential section (increment 43, Slice B1/B2) — the Credential
// step after credentialEnvVar in the Full Access panel. Mirrors
// docs/methods/43-platform-inline-credential-bind.md's three modes: skip
// (default, public CLI) / use-existing (bind a vault-unlinked credential) /
// create-new (mint one inline, CREATE-only — no silent upsert).
// ---------------------------------------------------------------------------

export type FullAccessCredentialMode = "skip" | "existing" | "new"

/** One unlinked credential option for the "use existing" Select — metadata only. */
export interface UnlinkedCredentialOption {
  id: string
  name: string
  account: string
  kind: string
}

export interface FullAccessCredentialFormState {
  mode: FullAccessCredentialMode
  /** Populated by listUnlinkedCredentialsFn, kind-filtered to "env" client-side. */
  unlinkedOptions: UnlinkedCredentialOption[]
  /** True while the unlinked-credentials fetch is in flight. */
  loadingUnlinked: boolean
  /** Selected credential id — "use existing" mode only. */
  selectedCredentialId: string
  /** "Create new" mode fields. */
  newName: string
  newSecret: string
  newAccount: string
  /**
   * Set when a create-new submit hits a duplicate-account collision — the
   * account label that already has a credential on this platform. Drives the
   * explicit "use it / replace its secret" recovery UI (R4 — never a silent
   * overwrite). Cleared once the user picks a recovery action.
   */
  duplicateAccount?: string
  /** The colliding credential's id, resolved once the recovery UI needs to bind/rotate it. */
  duplicateCredentialId?: string
  /** True once the user clicks "Replace its secret" — reveals the inline new-secret field. */
  replacingSecret: boolean
  /** The new secret typed into the inline replace field — sent to rotateCredentialFn on submit. */
  replaceSecretValue: string
  /** Bind/create error message, if the last submit failed (surfaced by the route). */
  error?: string
}

export function emptyFullAccessCredentialState(): FullAccessCredentialFormState {
  return {
    mode: "skip",
    unlinkedOptions: [],
    loadingUnlinked: false,
    selectedCredentialId: "",
    newName: "",
    newSecret: "",
    newAccount: "",
    replacingSecret: false,
    replaceSecretValue: "",
  }
}

export interface FullAccessFormState {
  /** Bare command name typed into the discovery input, e.g. "gh". */
  binaryName: string
  /** Candidates returned by the last discoverCliBinaryFn call. */
  candidates: CliBinaryCandidateState[]
  /** Selected realpath — defaults to candidates[0] (the recommendation) once discovered. */
  selectedRealpath: string
  /** True when the user opts into the manual "enter path manually" escape hatch. */
  manualPath: boolean
  /** The manually-entered absolute path (only used when manualPath is true). */
  manualPathValue: string
  /**
   * Network access mode:
   *  - "denied"    → no network (default, safe)
   *  - "allowlist" → only the host:port rows in `allowNet`
   *  - "full"      → any host on any port (translated to "*" at install)
   */
  netMode: "denied" | "allowlist" | "full"
  /** host:port rows — only meaningful when netMode === "allowlist". */
  allowNet: CliPathFormState[]
  credentialEnvVar: string
  /** True while a discoverCliBinaryFn call is in flight. */
  discovering: boolean
  /** Discovery error message, if the last discover call failed. */
  discoverError?: string
  /** Set once install succeeds — the summary line ("Mapped N commands…"). */
  installSummary?: string
  /** Increment 43 — the inline Credential section's state (skip/existing/new). */
  credential: FullAccessCredentialFormState
}

export function emptyFullAccessState(): FullAccessFormState {
  return {
    binaryName: "",
    candidates: [],
    selectedRealpath: "",
    manualPath: false,
    manualPathValue: "",
    netMode: "denied",
    allowNet: [],
    credentialEnvVar: "",
    discovering: false,
    credential: emptyFullAccessCredentialState(),
  }
}

export interface CliConnectionFormState {
  mode: CliAccessMode
  tools: CliToolFormState[]
  credentialEnvVar: string
  fullAccess: FullAccessFormState
}

let keyCounter = 0
/** Client-only unique key generator for list items (tools/args) — not persisted. */
export function nextKey(prefix: string): string {
  keyCounter += 1
  return `${prefix}-${keyCounter}`
}

/** Build a stable-keyed path row for a PathRepeater (readPaths/writePaths/network.hosts). */
export function emptyPathRow(value = ""): CliPathFormState {
  return { id: nextKey("path"), value }
}

/** Build a stable-keyed env-var row for the Static Env Vars repeater. */
export function emptyEnvAllowRow(key = "", value = ""): CliEnvAllowFormState {
  return { id: nextKey("env"), key, value }
}

export function emptyPolicy(): CliPolicyFormState {
  return {
    cwd: "",
    readPaths: [],
    writePaths: [],
    network: { mode: "denied" },
    timeoutMs: "15000",
    envAllow: [],
  }
}

export function emptyTool(): CliToolFormState {
  return {
    key: nextKey("tool"),
    name: "",
    description: "",
    commandLine: "",
    args: [],
    policy: emptyPolicy(),
    advanced: false,
    rawJson: "",
  }
}

export function emptyConnection(): CliConnectionFormState {
  return {
    // Full CLI access is the default — install a CLI by name and let agents
    // drive the whole tool; declared commands is the opt-in narrower mode.
    mode: "full-access",
    tools: [emptyTool()],
    credentialEnvVar: "",
    fullAccess: emptyFullAccessState(),
  }
}
