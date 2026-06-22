# Agent ↔ Platform Broker — Idea Walkthrough

> Captured 2026-06-22. A self-hosted, single-user broker that becomes the one place you connect your platform accounts once, so any AI agent (Claude, ChatGPT, internal tools) can reach that data through MCP / CLI / API — granular, profiled, sandboxed, and secured. This document preserves the full idea, the pain behind it, the competitive landscape, and the intended way to build it. It is **not** a project and **not** a spark — it's a faithful write-up of everything discussed, staged in `migrations/` for a later `/new` or `/migrate`.

---

## 1. The problem (in your words, dated)

Across multiple recent moments, the same shape of pain recurred: **you're working with an AI agent on one machine/account, and it cannot reach data that lives behind a different account or platform — so you either shuttle the data manually or abandon the task.** You said this is "literally an everyday problem" and "has been a problem for a very long time."

Three concrete, dated instances:

**Moment #1 — Today.**
You have a Claude.ai subscription and wanted to talk through business matters, but Claude didn't know your business internals. Claude can't accept more than one Gmail / GitHub / etc. account, so you either had to **disconnect your already-linked personal accounts** to attach the business ones, or do it by hand.
→ *Workaround: did it manually — copied content out of emails and other platforms and pasted it into Claude.*

**Moment #2 — Last week.**
You wanted to do a quick GitHub review through your Claude terminal, but your local machine didn't have GitHub connected with your **work** account.
→ *Workaround: manually minted a new GitHub token, wired up the GitHub remote MCP, then did the review. The same reviews also needed Sentry and other data, which had to be shared manually each time. All of it could have been one-time if there were a single good source to point the agent at.*

**Moment #3 — Last month.**
You wanted to connect your multiple platforms to a *new* agent — Claude, ChatGPT, another platform you have access to, or internal tools you're building — over MCP or otherwise. You couldn't, because either the AI platform didn't support the platform you wanted, or you had to manually link accounts to it; and if you later discontinue (e.g.) ChatGPT, you then have to manually unlink everything. Too much friction.
→ *Workaround: abandoned the task or did it entirely by hand.*

**The throughline:** per-agent, per-platform manual account wiring; single-account ceilings on consumer AI products; no one place that holds your connections and exposes them to whatever agent you happen to be using. The cost is paid in manual copy-paste and dropped tasks, every day.

---

## 2. What you tried, and why it falls short

- **Composio** — closest existing thing you reached for. The blocker: it **doesn't support CLIs as a source**, nor OpenAPI specs or the other source types you want. Its catalog is SaaS-OAuth-shaped, not "any source / any credential pattern."
- **RhysSullivan/executor** ([github.com/RhysSullivan/executor](https://github.com/RhysSullivan/executor)) — has the source breadth you admire: first-party OpenAPI / GraphQL / MCP / Google-Discovery + custom JS, a TypeScript runtime in a secure Cloudflare-Worker sandbox, one tool catalog shared across Cursor / Claude Code / OpenCode. You want **your version**, but materially better on **profiling, sandboxing, and breadth** of platforms / MCPs / agents / skills / APIs.

The felt gap: *one source of truth for "what am I connected to and how does an agent use it," that you own, that any agent can plug into, with proper profiles, security, and source-type flexibility.*

---

## 3. The full vision (everything you want)

You described a complete product platform. Capturing all of it verbatim-in-spirit, unabridged:

1. **Granular agent access.** Access should be granular: organized by **profiles** and **platforms**, with data sources of many kinds — **MCP, CLI, API, OpenAPI spec**, or anything that follows a recognizable credential pattern. Credential patterns to support: **file-based, API tokens, OAuth — anything.**

2. **Scoped external API tokens + agent knowledge base.** Mint specific API tokens for external use of a platform, shareable **per profile, per platform, per data source, or more granular still.** Build an **internal knowledge base** so agents can quickly learn *what's connected and how to use it.*

3. **Dual execution model.** Be able to **run code-style** as well as MCP-style tool usage — i.e. both the MCP pattern and a code-styled pattern (similar to Rhys's Executor).

4. **Easy install + web app.** Installable via **npm, brew, or something simpler**, and it **sets things up quickly** on start. A **web app** to configure it easily and manage MCPs, agents, skills — everything.

5. **Secure credential layer.** A genuinely **secure credential layer** so everything stored in the platform is strongly protected.

6. **Secret-manager reuse.** A way to **reuse credentials easily** — effectively a secret-manager space.

7. **Knowledge-base UI.** A good KB **UI** that showcases what each data source provides and how to use it.

8. **Auditing.** Per-API-token / per-user auditing — how much, what data, full logs of access.

9. **Performance & reliability.** Performance and **latency** matter; proper **failure controls** and robust handling throughout.

> "More things in future maybe." — explicitly open-ended beyond the nine.

---

## 4. How you want to build it

Two separate things you expressed — a **build order** and a **per-slice workflow**:

### Build order (your stated preference)
- Set up the **base / core first**: a **web platform + CLI setup**.
- Then the **sandbox foundation**.
- Start from the **smallest case**, build smaller things until the **core / foundation is ready**.
- Only **after** the core is ready, move on to building features.

### Per-increment workflow (your stated preference)
For each thing you build, you like this loop:

1. **Research** the problem.
2. **Plan around the codebase** — research best tooling and best ways to set things up (which components to use, whether a new package is needed, architectural questions).
3. **Produce a plan** for you with a final set of reviews.
4. **You approve** → go ahead and build it.
5. **QA / test** it yourself (the agent).
6. **Background review.**
7. **Ask you to test.**
8. **You approve** → move to the next point.

Foundation-before-features, smallest-case-first, with an approval gate at the plan stage and again after testing, every increment.

---

## 5. Competitive landscape (researched 2026-06-22)

This is a **mature, crowded category** in 2026. The capabilities you described as differentiators each already ship somewhere:

| Tool | What it is | Overlap with your idea |
|---|---|---|
| **Executor** (RhysSullivan) | Local control plane; OpenAPI/GraphQL/MCP/Google-Discovery + custom-JS sources; TS runtime in a Cloudflare-Worker sandbox; one catalog across agents | Source breadth ✓, sandboxed code execution ✓ (your #3), agent-agnostic catalog ✓ |
| **MCPJungle** | Self-hosted, single-binary, "one place to manage all your MCP servers," tool-group scoping per client | Personal/self-hosted single-place framing ✓ |
| **Bifrost / Docker MCP Gateway** | Self-hosted; **profiles that scope which tools each client sees**; OAuth 2.0 + PKCE; CLI-driven | Profiling ✓ (your #1), CLI-driven setup ✓ |
| **mcpgate** | Self-hosted; two-layer policy (company + user, YAML); 22 integrations + **OpenAPI / MCP-URL import**; PII pseudonymization | Source import ✓, policy/scoping ✓ |
| **AnythingMCP** | Closest 1-for-1 Composio alternative; self-hosted (`docker compose up`), EU residency | Self-hosted broker ✓ |
| **Obot** | Control plane over any MCP server (community/internal); self-hosted K8s/Docker or managed | Control-plane framing ✓ |
| **Nango** | Code-first integrations across 800+ APIs; data syncs, webhooks, MCP server; build tools with AI coding agents | Source breadth ✓ |
| **Arcade** (Okta-backed) | Treats every tool call as a permissioned action tied to a user identity ("act as the logged-in user") | Per-identity scoped access ✓ |
| **Portkey / MintMCP / TrueFoundry / Kong** | Managed/enterprise MCP gateways: unified key, OAuth/OIDC/SAML, RBAC, audit, vaulted creds | Credential brokering ✓ (your #5/#6), auditing ✓ (your #8) |

**Honest read:** sandboxing (Executor), profiling (Bifrost/Docker), broad source support (Executor/mcpgate/Nango), credential vaulting + auditing (the enterprise gateways), and the self-hosted single-user framing (MCPJungle/AnythingMCP) are **all shipped today**. The general "better broker that supports more platforms/MCPs/agents/skills/APIs" is squarely occupied.

**The one wedge that looked least occupied** in conversation: **personal, multiple-accounts-per-platform profiles for a single individual** spanning consumer AI (the Claude.ai single-Gmail ceiling that triggered Moment #1) *plus* CLI *plus* other agents — i.e. the consumer-personal-multi-account angle rather than the enterprise-team angle the incumbents target. If this idea is revisited, that wedge is the most defensible starting point.

**Sources:**
- [github.com/RhysSullivan/executor](https://github.com/RhysSullivan/executor) · [executor.sh](https://executor.sh/)
- [github.com/mcpjungle/MCPJungle](https://github.com/mcpjungle/MCPJungle)
- [Composio alternatives — Nango](https://nango.dev/blog/composio-alternatives/) · [AnythingMCP](https://anythingmcp.com/vs/alternatives-to-composio)
- [13 Best MCP Gateways — Obot](https://obot.ai/blog/the-13-best-mcp-gateways-for-enterprise-teams/) · [MCP Gateways 2026 — ByteBridge](https://bytebridge.medium.com/mcp-gateways-in-2026-top-10-tools-for-ai-agents-and-workflows-d98f54c3577a)
- [What is an MCP Gateway — Kong](https://konghq.com/blog/learning-center/what-is-a-mcp-gateway) · [Self-hosted MCP gateways — MintMCP](https://www.mintmcp.com/blog/mcp-gateways-self-hosted-deployments)

---

## 6. Gate status (why this is a document, not yet a project)

This idea was run through the repo's four-check `/new` gate on 2026-06-22:

- **Pain — ✓ passed.** Three distinct, dated moments with real workarounds (Section 1).
- **Obsolescence — ⚠ warn.** Adjacent shipped tools (Executor, MCPJungle, Bifrost, mcpgate). You elected to continue on an execution-quality bet.
- **Duplicate — ⚠ warn.** Close maintained prior art covering most of the v0 surface. You elected to continue.
- **Scope — ✗ fail.** The chosen framing — *"foundation is v0"* (web platform + CLI core + credential layer built to host future features, before any agent actually reads data) — is the archive pattern the repo's binding **MVP-only rule** rejects. v0 must be a pain-fixing **vertical slice** on a thin foundation, not a foundation-as-deliverable.

**No project folder and no spark were created** — per your instruction, this walkthrough document is the only artifact.

---

## 7. The path to a buildable v0 (when you want it)

The idea is sound and the pain is real; only the **building order** blocked the gate. To turn this into a project, reframe v0 from "the core" to "the first vertical slice":

> **Proposed v0** — `npx`/CLI to start a single-user, self-hosted broker with a secure credential store. Connect **one** real platform from your pain log (e.g. work-GitHub) with a **profile** (multiple-accounts-per-platform — the wedge), and expose it through **one MCP endpoint** an agent points at. A minimal web connect-flow only if that single slice needs it. Foundation thickens as platform #2 and #3 demand it.

Each subsequent slice adds a platform and grows the core — by the third slice you have the foundation you wanted, but you were never more than one slice away from working software. **Everything in Section 3 (all nine points) is preserved as future scope and built after v0 ships**, each re-justified as it comes up.

To proceed later: run `/migrate agent-platform-broker.md` (re-runs the gate; pass it by accepting a vertical-slice v0), or `/new` with the sharpened consumer-personal-multi-account wedge from Section 5.

<!-- files: migrations/agent-platform-broker.md -->
