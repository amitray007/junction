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

The foundation increments (0 → 9) are in progress — the core is "ready" after increment 8,
with increment 9 (the TUI dashboard) completing it. Until they complete, there is no install
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

## Local development & testing

```bash
pnpm install
pnpm build          # build all packages
pnpm verify         # the gate: typecheck + lint + tests

# the ./junction launcher runs the built CLI against a persistent, gitignored
# dev home (<repo>/.junction):
./junction init
./junction platform list
./junction web      # localhost dashboard

JUNCTION_HOME=~/.junction ./junction status   # point at your real vault instead
```

`./junction` runs `dist/`, so rebuild (`pnpm build`) after changing source. See the
`junction-dev` skill for the full surface.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## License

[AGPL-3.0-only](LICENSE) — copyleft with §13 network-use disclosure. If you run a modified
junction over a network, you must offer the Corresponding Source to users of that service.
