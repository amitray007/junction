// SPDX-License-Identifier: AGPL-3.0-only
// AgentConfig — Connect-an-Agent block. LIVE (inc 27): the shared HTTP MCP
// endpoint is real — `junction serve` binds it. §2.6 of
// docs/methods/27-junction-keys-single-endpoint.md.
//
// LOAD-BEARING INVARIANTS:
// - Endpoint display is ALWAYS `http://127.0.0.1:<port>/mcp`, regardless of
//   mcpHost. Do NOT derive the endpoint from mcpHost — a non-loopback mcpHost
//   would produce a config the loopback Host guard 403s. If mcpHost is set and
//   non-loopback, render an honest note instead of a broken URL.
// - The dashboard cannot know whether `junction serve` is actually running —
//   never fake liveness. An honest "requires junction serve running" line is
//   always shown alongside the config.
// - Config snippets carry a real `Bearer <paste-your-key>` placeholder + a
//   link to /keys — never a fake/example key.

import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { isLocalHost } from "../server/host-guard.js"
import { MonoCode } from "./code.js"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AgentConfigProps {
  /** The resolved MCP HTTP port (config ?? JUNCTION_MCP_PORT ?? 4322). */
  readonly mcpPort: number
  /** The resolved MCP host setting — used ONLY to detect a non-loopback value
   *  for the honest-note branch. NEVER used to build the endpoint URL. */
  readonly mcpHost: string | undefined
}

// ---------------------------------------------------------------------------
// Config string builders — always localhost, never derived from mcpHost.
// ---------------------------------------------------------------------------

const BEARER_PLACEHOLDER = "<paste-your-key>"

function buildEndpoint(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

function buildClaudeConfig(port: number): string {
  return `{
  "mcpServers": {
    "junction": {
      "type": "http",
      "url": "${buildEndpoint(port)}",
      "headers": { "Authorization": "Bearer ${BEARER_PLACEHOLDER}" }
    }
  }
}`
}

function buildCursorConfig(port: number): string {
  return `junction:
  url: ${buildEndpoint(port)}
  headers:
    Authorization: Bearer ${BEARER_PLACEHOLDER}`
}

// The stdio "today" config is always the same — not host/port-dependent.
const STDIO_CONFIG = "junction mcp serve --profile <name>"

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
// Copy button
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
// Honesty notes
// ---------------------------------------------------------------------------

// Always present: the dashboard cannot know whether `junction serve` is
// actually running — never fake liveness (probing is a later increment).
function ServeRequiredNote() {
  return (
    <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
      Requires <MonoCode style={{ color: "var(--blue-text)" }}>junction serve</MonoCode> to be
      running.
    </p>
  )
}

// Shown ONLY when mcpHost is set and non-loopback — the endpoint is still
// localhost-only in this version; do not render a broken/misleading URL.
function NonLoopbackHostNote() {
  return (
    <p style={{ fontSize: "var(--text-caption)", color: "var(--status-warning-fg)", margin: 0 }}>
      Networked HTTP serving is deferred — the endpoint is localhost-only in this version, even
      though a non-loopback MCP host is configured.
    </p>
  )
}

// ---------------------------------------------------------------------------
// AgentConfig
// ---------------------------------------------------------------------------

export function AgentConfig({ mcpPort, mcpHost }: AgentConfigProps) {
  const endpoint = buildEndpoint(mcpPort)
  const claudeConfig = buildClaudeConfig(mcpPort)
  const cursorConfig = buildCursorConfig(mcpPort)
  const nonLoopbackHostConfigured = mcpHost !== undefined && mcpHost !== "" && !isLocalHost(mcpHost)

  return (
    <section
      aria-labelledby="agent-config-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      {/* Endpoint row — ALWAYS 127.0.0.1:<port>/mcp, never derived from mcpHost. */}
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
              color: "var(--blue-text)",
              flex: 1,
              userSelect: "text",
            }}
          >
            {endpoint}
          </span>
          <CopyButton text={endpoint} label="Copy MCP endpoint URL" />
        </div>
        {nonLoopbackHostConfigured && <NonLoopbackHostNote />}
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
            <div style={{ position: "relative" }}>
              <MonoBlock>{claudeConfig}</MonoBlock>
              <div style={{ position: "absolute", top: "8px", right: "8px" }}>
                <CopyButton text={claudeConfig} label="Copy Claude MCP config" />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="cursor">
            <div style={{ position: "relative" }}>
              <MonoBlock>{cursorConfig}</MonoBlock>
              <div style={{ position: "absolute", top: "8px", right: "8px" }}>
                <CopyButton text={cursorConfig} label="Copy Cursor MCP config" />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="raw">
            <MonoBlock>{STDIO_CONFIG}</MonoBlock>
          </TabsContent>
        </Tabs>
      </div>

      {/* Key hint — points at /keys where a real key is minted. */}
      <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
        Replace <MonoCode>{BEARER_PLACEHOLDER}</MonoCode> with a real key from{" "}
        <Link to="/keys" style={{ color: "var(--blue-text)", textDecoration: "underline" }}>
          Keys
        </Link>
        . The key selects which profile(s) the agent gets.
      </p>

      {/* Honesty note — ALWAYS present: we cannot know if `junction serve` is running. */}
      <ServeRequiredNote />
    </section>
  )
}
