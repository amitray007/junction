// SPDX-License-Identifier: AGPL-3.0-only
// Settings route — MCP Host form + Theme toggle.
// Phase 3 (D5): real Settings page backed by core config + JUNCTION_MCP_HOST env.
// No @junction/core import — all data flows through server-fns.

import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"
import type { SettingsData } from "../server/data.functions.js"
import { getSettings } from "../server/data.functions.js"
import { setMcpHostFn } from "../server/settings.functions.js"
import { Button } from "../ui/button.js"
import { Field } from "../ui/field.js"
import { Input } from "../ui/input.js"
import { PageHeader } from "../ui/page-header.js"
import { ThemeToggle } from "../ui/sidebar.js"

export const Route = createFileRoute("/settings")({
  loader: () => getSettings(),
  component: SettingsPage,
})

// ── Source note ───────────────────────────────────────────────────────────────

function SourceNote({ source }: { readonly source: SettingsData["mcpHostSource"] }) {
  if (source === "config") {
    return (
      <span
        style={{
          fontSize: "var(--text-caption)",
          color: "var(--gray-600)",
          fontFamily: "var(--font-mono)",
        }}
      >
        from config
      </span>
    )
  }
  if (source === "env") {
    return (
      <span
        style={{
          fontSize: "var(--text-caption)",
          color: "var(--gray-600)",
          fontFamily: "var(--font-mono)",
        }}
      >
        from JUNCTION_MCP_HOST
      </span>
    )
  }
  return null
}

// ── MCP Host section ─────────────────────────────────────────────────────────

function McpHostSection({ data }: { readonly data: SettingsData }) {
  const router = useRouter()
  const [hostInput, setHostInput] = useState(data.mcpHost ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [fieldError, setFieldError] = useState<string | undefined>(undefined)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    // Client-side: non-empty unless clearing. Shape validation deferred to server.
    const trimmed = hostInput.trim()
    if (trimmed !== "" && trimmed.includes("://")) {
      setFieldError("Enter a hostname or hostname:port — no scheme (https:// etc.)")
      return
    }
    setFieldError(undefined)
    setSubmitting(true)
    try {
      const result = await setMcpHostFn({ data: { host: trimmed } })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(trimmed === "" ? "MCP host cleared" : "MCP host saved")
      await router.invalidate()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleClear() {
    setHostInput("")
    setFieldError(undefined)
    setSubmitting(true)
    try {
      const result = await setMcpHostFn({ data: { host: "" } })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success("MCP host cleared")
      await router.invalidate()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section
      aria-labelledby="mcp-host-heading"
      style={{ display: "flex", flexDirection: "column", gap: "16px" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <h2
          id="mcp-host-heading"
          style={{
            fontSize: "var(--text-label)",
            fontWeight: 600,
            color: "var(--gray-1000)",
            margin: 0,
          }}
        >
          MCP Host
        </h2>
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
          The hostname where Junction&apos;s shared MCP endpoint will be reachable. Used by
          Connect&nbsp;an&nbsp;Agent to build the config string your agents copy.
        </p>
      </div>

      <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <Field
          id="settings-mcp-host"
          label="Host"
          error={fieldError}
          description='Enter a hostname or hostname:port, e.g. "junction.example.com" or "localhost:4321". No scheme.'
        >
          <Input
            id="settings-mcp-host"
            type="text"
            value={hostInput}
            onChange={(e) => {
              setHostInput(e.target.value)
              if (fieldError) setFieldError(undefined)
            }}
            placeholder="junction.example.com"
            hasError={fieldError !== undefined}
            disabled={submitting}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        {/* Source note — only when a value is currently resolved */}
        {data.mcpHostSource !== "none" && (
          <p
            style={{
              fontSize: "var(--text-caption)",
              color: "var(--gray-600)",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            Current value{" "}
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-mono)",
                color: "var(--gray-900)",
              }}
            >
              {data.mcpHost}
            </span>{" "}
            — <SourceNote source={data.mcpHostSource} />
          </p>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Save"}
          </Button>
          {data.mcpHost !== undefined && (
            <Button type="button" variant="ghost" onClick={handleClear} disabled={submitting}>
              Clear
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}

// ── Appearance / Theme section ────────────────────────────────────────────────

function AppearanceSection() {
  return (
    <section
      aria-labelledby="appearance-heading"
      style={{ display: "flex", flexDirection: "column", gap: "16px" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <h2
          id="appearance-heading"
          style={{
            fontSize: "var(--text-label)",
            fontWeight: 600,
            color: "var(--gray-1000)",
            margin: 0,
          }}
        >
          Appearance
        </h2>
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
          Choose between light and dark mode.
        </p>
      </div>

      {/* The canonical theme control rendered as a labeled button (Light/Dark). */}
      <ThemeToggle collapsed={false} withLabel />
    </section>
  )
}

// ── Separator ─────────────────────────────────────────────────────────────────

function SectionDivider() {
  return (
    <div
      aria-hidden="true"
      style={{ height: "1px", backgroundColor: "var(--alpha-200)", margin: "8px 0" }}
    />
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

function SettingsPage() {
  const data = Route.useLoaderData()

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
      <PageHeader title="Settings" subtitle="Junction-wide preferences." />

      {/* Constrain to a readable form column — settings fields shouldn't stretch the
          full 1216px content width (agentation feedback: "horizontally too long"). */}
      <div style={{ display: "flex", flexDirection: "column", gap: "32px", maxWidth: "40rem" }}>
        <McpHostSection data={data} />
        <SectionDivider />
        <AppearanceSection />
      </div>
    </div>
  )
}
