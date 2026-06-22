# junction

A self-hosted, single-user broker: the one place you connect your platform accounts once, so
any AI agent (Claude, ChatGPT, internal tools) can reach that data through MCP / CLI / API —
granular, profiled, sandboxed, and secured.

**The wedge:** one individual, multiple accounts on the same platform, switchable per agent.
Connect work-GitHub and personal-GitHub once; any agent uses the right one through its profile
endpoint — no manual token wiring, no single-account ceilings.

See [`docs/idea.md`](docs/idea.md) for the full pain log and vision.

---

## Status

**Foundation in active development — not yet usable.**

The foundation increments (0 → 8) are in progress. Until they complete, there is no install
path, no CLI binary, and no stable API. See [`docs/specs/`](docs/specs/) and
[`docs/methods/`](docs/methods/) for the build plan and per-increment method files.

---

## Architecture

pnpm TypeScript monorepo with a strict one-directional dependency graph:

```
packages/
  core/          @junction/core        — types, catalog, credential store, profile manager,
                                         persistence, sandbox interface. NO HTTP. Pure + tested.
  mcp/
    server/      @junction/mcp-server  — serves agents. McpServer over a Profile.
    client/      @junction/mcp-client  — consumes upstream MCP sources. Reserved.
  cli/           junction              — thin: argv → core.
  web/           @junction/web         — (later) imports core directly.
```

Core is pure; edges are thin. Logic lives in `core`; `cli`/`web`/`mcp/*` translate to/from it.

See [`docs/specs/2026-06-22-junction-foundation-design.md`](docs/specs/2026-06-22-junction-foundation-design.md)
for the full architecture and stack decisions.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## License

[AGPL-3.0-only](LICENSE) — copyleft with §13 network-use disclosure. If you run a modified
junction over a network, you must offer the Corresponding Source to users of that service.
