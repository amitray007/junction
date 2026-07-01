// SPDX-License-Identifier: AGPL-3.0-only
// ArgsPanel — one row per arg declared OR referenced by the command line.
// Diffs the $name references in commandLine against declared args[]: an arg
// referenced but not declared gets an auto-added row; a declared-but-unused
// arg is flagged "not used" (never silently deleted — the operator decides).

import { ChevronDown, ChevronRight, X } from "lucide-react"
import { useState } from "react"
import { tokenizeCommandLine } from "../../../lib/cli-command.js"
import {
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "../../../ui/index.js"
import type { CliArgType, CliToolArgFormState } from "./types.js"
import { nextKey } from "./types.js"

const ARG_TYPES: CliArgType[] = ["string", "number", "boolean", "enum", "path"]

/** The set of $name references found in the command line (order of first appearance). */
export function argNamesInCommandLine(commandLine: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const seg of tokenizeCommandLine(commandLine)) {
    if (seg.kind === "arg" && !seen.has(seg.name)) {
      seen.add(seg.name)
      names.push(seg.name)
    }
  }
  return names
}

interface ArgsPanelProps {
  readonly commandLine: string
  readonly args: CliToolArgFormState[]
  readonly onChange: (args: CliToolArgFormState[]) => void
}

export function ArgsPanel({ commandLine, args, onChange }: ArgsPanelProps) {
  const referenced = argNamesInCommandLine(commandLine)
  const declaredNames = new Set(args.map((a) => a.name))
  const orphaned = args.filter((a) => !referenced.includes(a.name))

  function addMissingArg(name: string) {
    onChange([
      ...args,
      {
        key: nextKey("arg"),
        name,
        description: "",
        type: "string",
        required: false,
        enumValues: [],
        pattern: "",
        maxLength: "",
      },
    ])
  }

  function updateArg(key: string, patch: Partial<CliToolArgFormState>) {
    onChange(args.map((a) => (a.key === key ? { ...a, ...patch } : a)))
  }

  function removeArg(key: string) {
    onChange(args.filter((a) => a.key !== key))
  }

  return (
    <div className="flex flex-col gap-2">
      <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
        Arguments
      </span>

      {referenced
        .filter((name) => !declaredNames.has(name))
        .map((name) => (
          <div
            key={name}
            className="flex items-center justify-between rounded-[var(--radius-6)] border px-3 py-2"
            style={{ borderColor: "var(--status-warning-fg)" }}
          >
            <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-900)" }}>
              <code style={{ fontFamily: "var(--font-mono)" }}>${name}</code> is used in the command
              but not declared yet.
            </span>
            <button
              type="button"
              onClick={() => addMissingArg(name)}
              style={{ fontSize: "var(--text-caption)", color: "var(--blue-text)" }}
            >
              Declare it
            </button>
          </div>
        ))}

      {args.map((arg) => (
        <ArgRow
          key={arg.key}
          arg={arg}
          unused={orphaned.some((o) => o.key === arg.key)}
          onChange={(patch) => updateArg(arg.key, patch)}
          onRemove={() => removeArg(arg.key)}
        />
      ))}
    </div>
  )
}

function ArgRow({
  arg,
  unused,
  onChange,
  onRemove,
}: {
  readonly arg: CliToolArgFormState
  readonly unused: boolean
  readonly onChange: (patch: Partial<CliToolArgFormState>) => void
  readonly onRemove: () => void
}) {
  const [constraintsOpen, setConstraintsOpen] = useState(false)

  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-6)] border p-3"
      style={{ borderColor: "var(--alpha-400)" }}
    >
      <div className="flex items-center justify-between">
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-mono)",
            color: "var(--gray-1000)",
          }}
        >
          ${arg.name}
        </span>
        <div className="flex items-center gap-2">
          {unused && (
            <span style={{ fontSize: "var(--text-caption)", color: "var(--status-warning-fg)" }}>
              not used
            </span>
          )}
          <button type="button" aria-label={`Remove arg ${arg.name}`} onClick={onRemove}>
            <X className="h-4 w-4" aria-hidden="true" style={{ color: "var(--gray-700)" }} />
          </button>
        </div>
      </div>

      <Field id={`arg-${arg.key}-description`} label="Description">
        <Input
          id={`arg-${arg.key}-description`}
          value={arg.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Field>

      <div className="flex items-center gap-4">
        <Field id={`arg-${arg.key}-type`} label="Type" className="flex-1">
          <Select value={arg.type} onValueChange={(v) => onChange({ type: v as CliArgType })}>
            <SelectTrigger id={`arg-${arg.key}-type`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ARG_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="flex items-center gap-2 pt-5">
          <Switch
            checked={arg.required}
            onCheckedChange={(v) => onChange({ required: v })}
            aria-label="Required"
          />
          <span style={{ fontSize: "var(--text-label)", color: "var(--gray-1000)" }}>Required</span>
        </div>
      </div>

      {arg.type === "enum" && (
        <Field id={`arg-${arg.key}-enum`} label="Allowed Values" description="Comma-separated.">
          <Input
            id={`arg-${arg.key}-enum`}
            value={arg.enumValues.join(", ")}
            onChange={(e) =>
              onChange({
                enumValues: e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      )}

      <button
        type="button"
        className="flex items-center gap-1 self-start"
        onClick={() => setConstraintsOpen((v) => !v)}
        aria-expanded={constraintsOpen}
      >
        {constraintsOpen ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
          Constraints
        </span>
      </button>

      {constraintsOpen && (
        <div className="flex gap-2">
          <Field id={`arg-${arg.key}-pattern`} label="Pattern" className="flex-1">
            <Input
              id={`arg-${arg.key}-pattern`}
              placeholder="regex, anchored"
              value={arg.pattern}
              onChange={(e) => onChange({ pattern: e.target.value })}
            />
          </Field>
          <Field id={`arg-${arg.key}-maxlength`} label="Max Length" className="flex-1">
            <Input
              id={`arg-${arg.key}-maxlength`}
              type="number"
              max={4096}
              value={arg.maxLength}
              onChange={(e) => onChange({ maxLength: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  )
}
