// SPDX-License-Identifier: AGPL-3.0-only
// ToolCard — one operator-declared CLI tool: command builder + live argv preview +
// arguments panel + permissions panel. Header is a summary; the body is an accordion.
// Tools with an irreversible descriptor (edit mode only) show a read-only notice +
// a JSON escape hatch instead of the guided command builder.

import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react"
import {
  argvToChips,
  firstTokenIsAbsolutePath,
  tokenizeCommandLine,
} from "../../../lib/cli-command.js"
import {
  Card,
  Field,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "../../../ui/index.js"
import { ArgsPanel } from "./args-panel.js"
import { PolicyPanel } from "./policy-panel.js"
import type { CliToolFormState } from "./types.js"

interface ToolCardProps {
  readonly tool: CliToolFormState
  readonly index: number
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onChange: (tool: CliToolFormState) => void
  readonly onRemove: () => void
  readonly canRemove: boolean
  readonly errors?: Record<string, string>
}

function summaryCommand(tool: CliToolFormState): string {
  if (tool.advanced) return "advanced descriptor"
  return tool.commandLine.trim() || "(no command yet)"
}

export function ToolCard({
  tool,
  index,
  expanded,
  onToggle,
  onChange,
  onRemove,
  canRemove,
  errors,
}: ToolCardProps) {
  const preview = tool.advanced ? [] : tokenizeCommandLine(tool.commandLine)
  const chips = argvToChips(preview)
  const argv0Ok = firstTokenIsAbsolutePath(preview)

  return (
    <Card className="p-0">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown
              className="h-4 w-4"
              aria-hidden="true"
              style={{ color: "var(--gray-700)" }}
            />
          ) : (
            <ChevronRight
              className="h-4 w-4"
              aria-hidden="true"
              style={{ color: "var(--gray-700)" }}
            />
          )}
          <span style={{ fontSize: "var(--text-h3)", fontWeight: 600, color: "var(--gray-1000)" }}>
            {tool.name.trim() || `Tool ${index + 1}`}
          </span>
        </div>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-mono)",
            color: "var(--gray-700)",
          }}
        >
          {summaryCommand(tool)}
        </span>
      </button>

      {expanded && (
        <div
          className="flex flex-col gap-4 border-t px-4 py-4"
          style={{ borderColor: "var(--alpha-200)" }}
        >
          <div className="flex items-center justify-between">
            <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              Tool {index + 1}
            </span>
            <button
              type="button"
              disabled={!canRemove}
              onClick={onRemove}
              title={canRemove ? "Remove this tool" : "A CLI platform needs at least one tool"}
              style={{
                fontSize: "var(--text-caption)",
                color: canRemove ? "var(--status-error-fg)" : "var(--gray-700)",
                opacity: canRemove ? 1 : 0.5,
              }}
            >
              Remove Tool
            </button>
          </div>

          <div className="flex gap-4">
            <Field
              id={`tool-${tool.key}-name`}
              label="Name"
              error={errors?.name}
              className="flex-1"
            >
              <Input
                id={`tool-${tool.key}-name`}
                placeholder="e.g. search"
                value={tool.name}
                onChange={(e) => onChange({ ...tool, name: e.target.value })}
                hasError={!!errors?.name}
              />
            </Field>
            <Field id={`tool-${tool.key}-description`} label="Description" className="flex-1">
              <Input
                id={`tool-${tool.key}-description`}
                value={tool.description}
                onChange={(e) => onChange({ ...tool, description: e.target.value })}
              />
            </Field>
          </div>

          {tool.advanced ? (
            <div className="flex flex-col gap-2">
              <div
                className="flex items-start gap-2 rounded-[var(--radius-6)] border px-3 py-2"
                style={{ borderColor: "var(--status-warning-fg)" }}
              >
                <AlertTriangle
                  className="h-4 w-4 shrink-0"
                  aria-hidden="true"
                  style={{ color: "var(--status-warning-fg)" }}
                />
                <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-900)" }}>
                  This tool's argv can't be safely represented in the guided command builder (two
                  positions share one arg name, or an argv slot references an undeclared arg). Edit
                  the raw JSON instead.
                </span>
              </div>
              <Tabs defaultValue="json">
                <TabsList>
                  <TabsTrigger value="json">JSON</TabsTrigger>
                </TabsList>
                <TabsContent value="json">
                  <Textarea
                    aria-label="Tool descriptor JSON"
                    value={tool.rawJson}
                    onChange={(e) => onChange({ ...tool, rawJson: e.target.value })}
                    style={{ minHeight: "160px", fontFamily: "var(--font-mono)" }}
                  />
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <>
              <Field
                id={`tool-${tool.key}-command`}
                label="Command"
                description="Type the command. Use $name for values the agent fills in. The first token must be an absolute path to the binary."
                error={errors?.commandLine}
              >
                <Input
                  id={`tool-${tool.key}-command`}
                  placeholder="/opt/homebrew/bin/rg --json $pattern"
                  value={tool.commandLine}
                  onChange={(e) => onChange({ ...tool, commandLine: e.target.value })}
                  hasError={!!errors?.commandLine}
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </Field>

              <div className="flex flex-col gap-1.5">
                <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
                  Preview
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {chips.length === 0 ? (
                    <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-600)" }}>
                      (empty)
                    </span>
                  ) : (
                    chips.map((chip, i) => (
                      <span
                        // biome-ignore lint/suspicious/noArrayIndexKey: chips re-derive from commandLine every render; index is positionally stable within one render
                        key={i}
                        className="rounded-[var(--radius-6)] px-1.5 py-0.5"
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--text-mono)",
                          color: chip.kind === "arg" ? "var(--blue-text)" : "var(--gray-900)",
                          backgroundColor:
                            chip.kind === "arg" ? "var(--blue-bg)" : "var(--gray-100)",
                        }}
                      >
                        {chip.label}
                      </span>
                    ))
                  )}
                </div>
                <span
                  style={{
                    fontSize: "var(--text-caption)",
                    color: argv0Ok ? "var(--status-ok-fg)" : "var(--status-error-fg)",
                  }}
                >
                  {argv0Ok
                    ? "argv[0] is an absolute path"
                    : "argv[0] must be a literal absolute path (e.g. /usr/bin/…)"}
                </span>
              </div>

              <ArgsPanel
                commandLine={tool.commandLine}
                args={tool.args}
                onChange={(args) => onChange({ ...tool, args })}
              />
            </>
          )}

          <PolicyPanel
            toolKey={tool.key}
            policy={tool.policy}
            onChange={(policy) => onChange({ ...tool, policy })}
          />
        </div>
      )}
    </Card>
  )
}
