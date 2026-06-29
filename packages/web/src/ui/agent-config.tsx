// SPDX-License-Identifier: AGPL-3.0-only
// AgentConfig — Connect-an-Agent block.
// Phase 3 (D5): when mcpHost is set, renders a REAL copyable endpoint + config.
// When unset, falls back to the <your-junction-host> placeholder + a prompt to set it.
//
// HONESTY GUARD: The shared HTTP MCP endpoint does NOT exist yet — the server is
// stdio-only. Either way (host set or unset), the "isn't live yet" note MUST remain.
// A Copy button is legitimate once the user has provided a real host (it copies a
// real string they wrote), but the note makes clear it isn't a live endpoint today.

import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { MonoCode } from "./code.js"
import { ComingSoon } from "./coming-soon.js"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AgentConfigProps {
  /** The resolved MCP host (config ?? JUNCTION_MCP_HOST ?? undefined). */
  readonly mcpHost: string | undefined
}

// ---------------------------------------------------------------------------
// Config string builders — only called when mcpHost is set.
// ---------------------------------------------------------------------------

function buildEndpoint(host: string): string {
  return `https://${host}/mcp`
}

function buildClaudeConfig(host: string): string {
  return `{
  "mcpServers": {
    "junction": {
      "url": "https://${host}/mcp",
      "headers": { "Authorization": "Bearer <your-key>" }
    }
  }
}`
}

function buildCursorConfig(host: string): string {
  return `junction:
  url: https://${host}/mcp
  headers:
    Authorization: Bearer <your-key>`
}

// The stdio "today" config is always the same — not host-dependent.
const STDIO_CONFIG = "junction mcp serve --profile <name>"

// Placeholder strings when no host is set (non-copyable).
const PLACEHOLDER = {
  endpoint: "https://<your-junction-host>/mcp",
  claudeConfig: `{
  "mcpServers": {
    "junction": {
      "url": "https://<your-junction-host>/mcp",
      "headers": { "Authorization": "Bearer <your-key>" }
    }
  }
}`,
  cursorConfig: `junction:
  url: https://<your-junction-host>/mcp
  headers:
    Authorization: Bearer <your-key>`,
}

// ---------------------------------------------------------------------------
// Mono code block — non-copyable illustration
// ---------------------------------------------------------------------------

function MonoBlock({ children }: { readonly children: string }) {
  return (
    <pre
      aria-hidden="true"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-mono)",
        color: "var(--gray-900)",
        backgroundColor: "var(--bg-200)",
        border: "1px solid var(--alpha-200)",
        borderRadius: "var(--radius-6)",
        padding: "12px 14px",
        margin: 0,
        overflowX: "auto",
        lineHeight: 1.6,
        userSelect: "none",
        pointerEvents: "none",
      }}
    >
      {children}
    </pre>
  )
}

// ---------------------------------------------------------------------------
// Copy button — only rendered when mcpHost is set (real string to copy).
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable (non-secure context) — silently ignore
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      onClick={handleCopy}
      style={{
        flexShrink: 0,
        fontSize: "var(--text-caption)",
        fontFamily: "var(--font-mono)",
        color: copied ? "var(--status-ok-fg)" : "var(--gray-700)",
        backgroundColor: "transparent",
        border: "none",
        cursor: "pointer",
        padding: "2px 6px",
        borderRadius: "var(--radius-6)",
        transition: "color var(--motion-fast)",
      }}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Honesty note — always present regardless of host state
// ---------------------------------------------------------------------------

function HonestyNote() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <ComingSoon />
      <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
        Shared HTTP endpoint isn&apos;t live yet — today, connect via stdio:{" "}
        <MonoCode style={{ color: "var(--blue-text)" }}>
          junction mcp serve --profile &lt;name&gt;
        </MonoCode>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AgentConfig
// ---------------------------------------------------------------------------

export function AgentConfig({ mcpHost }: AgentConfigProps) {
  const hasHost = mcpHost !== undefined && mcpHost !== ""

  const endpoint = hasHost ? buildEndpoint(mcpHost) : PLACEHOLDER.endpoint
  const claudeConfig = hasHost ? buildClaudeConfig(mcpHost) : PLACEHOLDER.claudeConfig
  const cursorConfig = hasHost ? buildCursorConfig(mcpHost) : PLACEHOLDER.cursorConfig

  return (
    <section
      aria-labelledby="agent-config-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        border: "1px dashed var(--alpha-400)",
        borderRadius: "var(--radius-12)",
        padding: "16px",
      }}
    >
      {/* Endpoint row */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <p
          id="agent-config-heading"
          style={{
            fontSize: "var(--text-label)",
            fontWeight: 500,
            color: "var(--gray-900)",
            margin: 0,
          }}
        >
          Shared endpoint
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 12px",
            borderRadius: "var(--radius-6)",
            border: "1px solid var(--alpha-200)",
            backgroundColor: "var(--bg-200)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-mono)",
              color: hasHost ? "var(--blue-text)" : "var(--gray-600)",
              flex: 1,
              userSelect: hasHost ? "text" : "none",
            }}
          >
            {endpoint}
          </span>
          {hasHost && <CopyButton text={endpoint} label="Copy MCP endpoint URL" />}
        </div>
        {!hasHost && (
          <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-600)", margin: 0 }}>
            Set your MCP host in{" "}
            <Link to="/settings" style={{ color: "var(--blue-text)", textDecoration: "underline" }}>
              Settings
            </Link>{" "}
            to see the real endpoint here.
          </p>
        )}
      </div>

      {/* Tabbed agent config */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <p
          style={{
            fontSize: "var(--text-label)",
            fontWeight: 500,
            color: "var(--gray-900)",
            margin: 0,
          }}
        >
          Agent config
        </p>
        <Tabs defaultValue="claude">
          <TabsList>
            <TabsTrigger value="claude">Claude</TabsTrigger>
            <TabsTrigger value="cursor">Cursor</TabsTrigger>
            <TabsTrigger value="raw">Today (stdio)</TabsTrigger>
          </TabsList>
          <TabsContent value="claude">
            {hasHost ? (
              <div style={{ position: "relative" }}>
                <MonoBlock>{claudeConfig}</MonoBlock>
                <div style={{ position: "absolute", top: "8px", right: "8px" }}>
                  <CopyButton text={claudeConfig} label="Copy Claude MCP config" />
                </div>
              </div>
            ) : (
              <MonoBlock>{claudeConfig}</MonoBlock>
            )}
          </TabsContent>
          <TabsContent value="cursor">
            {hasHost ? (
              <div style={{ position: "relative" }}>
                <MonoBlock>{cursorConfig}</MonoBlock>
                <div style={{ position: "absolute", top: "8px", right: "8px" }}>
                  <CopyButton text={cursorConfig} label="Copy Cursor MCP config" />
                </div>
              </div>
            ) : (
              <MonoBlock>{cursorConfig}</MonoBlock>
            )}
          </TabsContent>
          <TabsContent value="raw">
            <MonoBlock>{STDIO_CONFIG}</MonoBlock>
          </TabsContent>
        </Tabs>
      </div>

      {/* Key → profile — demoted to a quiet one-liner (Phase 2 note; not restructured here) */}
      <p style={{ fontSize: "var(--text-body)", color: "var(--gray-600)", margin: 0 }}>
        A junction key will select which profile an agent gets — coming soon.
      </p>

      {/* Honesty note — ALWAYS present regardless of host state */}
      <HonestyNote />
    </section>
  )
}
