// SPDX-License-Identifier: AGPL-3.0-only
// AgentConfig — ComingSoon surface: the intended single-endpoint + key→profile model.
// CRITICAL: renders NO working http endpoint and NO live Copy button.
// The MCP server is stdio-only (packages/mcp/server/src/serve.ts — "No HTTP transport").
// DashboardData carries no port/URL. A working http://…/mcp block would be fabricated.
// This block is purely illustrative: shows the future shape, disabled, with a stdio hint.

import { MonoChip, MonoCode } from "./code.js"
import { ComingSoon } from "./coming-soon.js"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js"

// Static illustration configs — shape of the FUTURE single-endpoint model.
// These are NOT real endpoints. There is no HTTP MCP server today — only stdio.
// Placeholder form uses angle-bracket tokens so it cannot be mistaken for a live URL.
const ILLUSTRATION = {
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
  rawConfig: `junction mcp serve --profile <name>`,
}

// Mono code block — non-copyable illustration
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

export function AgentConfig() {
  return (
    <section
      aria-labelledby="agent-config-heading"
      // inc 24.6: opacity removed — "coming soon" is signalled by the pill + copy,
      // not by dimming. Full contrast: illustrative but intentional.
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        border: "1px dashed var(--alpha-400)",
        borderRadius: "var(--radius-12)",
        padding: "16px",
      }}
    >
      {/* Endpoint — displayed but NOT copyable, NOT live */}
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
              userSelect: "none",
            }}
          >
            {ILLUSTRATION.endpoint}
          </span>
          {/* Copy button intentionally absent — no working endpoint yet */}
        </div>
      </div>

      {/* Tabbed config illustration */}
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
            <MonoBlock>{ILLUSTRATION.claudeConfig}</MonoBlock>
          </TabsContent>
          <TabsContent value="cursor">
            <MonoBlock>{ILLUSTRATION.cursorConfig}</MonoBlock>
          </TabsContent>
          <TabsContent value="raw">
            <MonoBlock>{ILLUSTRATION.rawConfig}</MonoBlock>
          </TabsContent>
        </Tabs>
      </div>

      {/* Key → profile chips — illustrative */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <p
          style={{
            fontSize: "var(--text-label)",
            fontWeight: 500,
            color: "var(--gray-900)",
            margin: 0,
          }}
        >
          Key selects profile
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
          <MonoChip style={{ padding: "2px 8px" }}>jk_work → work</MonoChip>
          <MonoChip style={{ padding: "2px 8px" }}>jk_personal → personal</MonoChip>
        </div>
      </div>

      {/* ComingSoon footer with stdio hint */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <ComingSoon />
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
          Today, agents connect over stdio with{" "}
          <MonoCode style={{ color: "var(--blue-text)" }}>
            junction mcp serve --profile &lt;name&gt;
          </MonoCode>
          . A shared HTTP endpoint with keys is coming soon.
        </p>
      </div>
    </section>
  )
}
