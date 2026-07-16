// SPDX-License-Identifier: AGPL-3.0-only
// FullAccessPanel — the "Full CLI access" install sub-flow (increment 41.4).
// docs/specs/2026-07-16-cli-exploratory-mode.md §5 Q1/Q3/Q6.
//
// Binary-name input → discoverCliBinaryFn → candidate picker (recommendation
// preselected, manual-path escape hatch) → optional net allowlist + credential
// env var → the Fable Q3/Q6 install-confirmation copy → submit installs via
// addFullAccessCliPlatformFn (called by the route) and shows a "Mapped N
// commands…" summary.
//
// SERVER-ONLY-CORE BOUNDARY: this file imports ONLY the .functions.ts server-fn
// wrappers (never platform-mutations.server.ts or @junction/core directly) —
// per docs/rules/web.md.

import { Plus, X } from "lucide-react"
import {
  type CliBinaryCandidate,
  discoverCliBinaryFn,
} from "../../../server/platform-mutations.functions.js"
import { Button, Field, Input } from "../../../ui/index.js"
import { credentialEnvVarError } from "./credential-env-var.js"
import type { CliPathFormState, FullAccessFormState } from "./types.js"
import { emptyPathRow } from "./types.js"

interface FullAccessPanelProps {
  readonly fullAccess: FullAccessFormState
  readonly onChange: (fullAccess: FullAccessFormState) => void
}

function candidateLabel(c: { source: "path" | "common-dir" }): string {
  return c.source === "path" ? "on PATH" : "common install dir"
}

function AllowNetRepeater({
  hosts,
  onChange,
}: {
  readonly hosts: CliPathFormState[]
  readonly onChange: (hosts: CliPathFormState[]) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {hosts.map((h, i) => (
        <div key={h.id} className="flex gap-2">
          <Input
            value={h.value}
            placeholder="api.github.com:443"
            onChange={(e) => {
              const next = [...hosts]
              next[i] = { ...h, value: e.target.value }
              onChange(next)
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Remove allowed host"
            onClick={() => onChange(hosts.filter((_, idx) => idx !== i))}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onChange([...hosts, emptyPathRow()])}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add Host
      </Button>
    </div>
  )
}

export function FullAccessPanel({ fullAccess, onChange }: FullAccessPanelProps) {
  function set<K extends keyof FullAccessFormState>(key: K, value: FullAccessFormState[K]) {
    onChange({ ...fullAccess, [key]: value })
  }

  async function handleDiscover() {
    const name = fullAccess.binaryName.trim()
    if (!name) {
      onChange({ ...fullAccess, discoverError: "Enter a binary name first" })
      return
    }
    onChange({ ...fullAccess, discovering: true, discoverError: undefined })
    try {
      const result = await discoverCliBinaryFn({ data: { name } })
      if (!result.ok) {
        onChange({ ...fullAccess, discovering: false, discoverError: result.error, candidates: [] })
        return
      }
      const candidates: CliBinaryCandidate[] = result.candidates
      const recommended = candidates[0]
      onChange({
        ...fullAccess,
        discovering: false,
        discoverError: candidates.length === 0 ? "No matching binary found" : undefined,
        candidates,
        selectedRealpath: recommended?.realpath ?? "",
        manualPath: candidates.length === 0,
      })
    } catch (e) {
      // Surface the real reason instead of an opaque "try again" — the common
      // causes are a non-localhost Host/Origin (403 from assertLocalHost) or the
      // server not seeing the binary on its PATH. Show it so the user can act.
      const detail =
        e instanceof Response
          ? `${e.status} ${e.statusText || "request rejected"}`
          : e instanceof Error && e.message
            ? e.message
            : "unexpected error"
      onChange({
        ...fullAccess,
        discovering: false,
        discoverError: `Discovery failed (${detail}) — check the server is reachable on localhost, or enter the path manually.`,
      })
    }
  }

  const envError = credentialEnvVarError(fullAccess.credentialEnvVar)
  const chosenPath = fullAccess.manualPath
    ? fullAccess.manualPathValue.trim()
    : fullAccess.selectedRealpath
  const resolvedLabel = fullAccess.binaryName.trim() || chosenPath.split("/").pop() || ""
  const hasBinaryLabel = resolvedLabel !== ""
  const binaryLabel = resolvedLabel || "this binary"

  return (
    <div className="flex flex-col gap-4">
      <Field
        id="fa-binary-name"
        label="Binary name"
        description="A bare command name Junction will look for on PATH and common install dirs (e.g. gh)."
      >
        <div className="flex gap-2">
          <Input
            id="fa-binary-name"
            placeholder="gh"
            value={fullAccess.binaryName}
            onChange={(e) => set("binaryName", e.target.value)}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => void handleDiscover()}
            disabled={fullAccess.discovering}
          >
            {fullAccess.discovering ? "Discovering…" : "Discover"}
          </Button>
        </div>
      </Field>

      {fullAccess.discoverError && (
        <p
          role="alert"
          style={{ fontSize: "var(--text-caption)", color: "var(--status-error-fg)" }}
        >
          {fullAccess.discoverError}
        </p>
      )}

      {fullAccess.candidates.length > 0 && !fullAccess.manualPath && (
        <fieldset className="flex flex-col gap-2">
          <legend
            style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}
          >
            Found binaries
          </legend>
          {fullAccess.candidates.map((c, i) => (
            <label
              key={c.realpath}
              className="flex items-center gap-2 rounded-[var(--radius-6)] border px-3 py-2"
              style={{ borderColor: "var(--alpha-400)", fontSize: "var(--text-body)" }}
            >
              <input
                type="radio"
                name="fa-candidate"
                checked={fullAccess.selectedRealpath === c.realpath}
                onChange={() => set("selectedRealpath", c.realpath)}
              />
              <span className="flex flex-1 flex-col">
                <span style={{ fontFamily: "var(--font-mono)" }}>{c.realpath}</span>
                <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
                  {candidateLabel(c)}
                  {c.version ? ` · v${c.version}` : ""}
                  {i === 0 ? " · recommended" : ""}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <label className="flex items-center gap-2" style={{ fontSize: "var(--text-body)" }}>
        <input
          type="checkbox"
          checked={fullAccess.manualPath}
          onChange={(e) => set("manualPath", e.target.checked)}
        />
        Enter path manually
      </label>

      {fullAccess.manualPath && (
        <Field
          id="fa-manual-path"
          label="Absolute path"
          description="Skip discovery and pin this binary directly."
        >
          <Input
            id="fa-manual-path"
            placeholder="/opt/homebrew/bin/gh"
            value={fullAccess.manualPathValue}
            onChange={(e) => set("manualPathValue", e.target.value)}
          />
        </Field>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend
          style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}
        >
          Network
        </legend>
        <label className="flex items-center gap-2" style={{ fontSize: "var(--text-body)" }}>
          <input
            type="radio"
            name="fa-net-mode"
            checked={fullAccess.netMode === "denied"}
            onChange={() => set("netMode", "denied")}
          />
          No network
        </label>
        <label className="flex items-center gap-2" style={{ fontSize: "var(--text-body)" }}>
          <input
            type="radio"
            name="fa-net-mode"
            checked={fullAccess.netMode === "allowlist"}
            onChange={() => set("netMode", "allowlist")}
          />
          Only specific hosts
        </label>
        <label className="flex items-center gap-2" style={{ fontSize: "var(--text-body)" }}>
          <input
            type="radio"
            name="fa-net-mode"
            checked={fullAccess.netMode === "full"}
            onChange={() => set("netMode", "full")}
          />
          Full network access
        </label>
        {fullAccess.netMode === "allowlist" && (
          <>
            <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              Add host:port entries the binary needs (e.g. api.github.com:443). On this OS egress is
              enforced by port, not host.
            </p>
            <AllowNetRepeater
              hosts={fullAccess.allowNet}
              onChange={(allowNet) => set("allowNet", allowNet)}
            />
          </>
        )}
      </fieldset>

      <Field
        id="fa-credential-env-var"
        label="Credential env var"
        description="Optional — the env var name the bound credential's secret is injected under."
        error={envError}
      >
        <Input
          id="fa-credential-env-var"
          placeholder="e.g. GH_PAT"
          value={fullAccess.credentialEnvVar}
          onChange={(e) => set("credentialEnvVar", e.target.value)}
          hasError={!!envError}
        />
      </Field>

      <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
        Agents can run any{" "}
        {hasBinaryLabel ? (
          <>
            <code style={{ fontFamily: "var(--font-mono)" }}>{binaryLabel}</code> command
          </>
        ) : (
          "command from this CLI"
        )}{" "}
        inside the sandbox. Junction maps its{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>--help</code> once at install — sandboxed,
        offline, no credentials.
      </p>

      {fullAccess.installSummary && (
        <p style={{ fontSize: "var(--text-body)", color: "var(--status-ok-fg)" }}>
          {fullAccess.installSummary}
        </p>
      )}
    </div>
  )
}
