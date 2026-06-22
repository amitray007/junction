# Performance Rules

Pragmatic, performance-by-default. No premature optimization, but good defaults that keep a single-user self-hosted broker fast and non-blocking.

## Event loop

- **MUST NOT** use `fs.*Sync` or `execSync` in `core` or server (`mcp/*`) paths — they block the event loop. (CLI startup/`init` scripts MAY use sync I/O where it simplifies one-shot setup.)
- **MUST NOT** do CPU-heavy work synchronously on a request/tool-call path; yield or move it off the hot path.

## Logging

- **MUST** use structured async logging via **pino** for the machine/audit trail; **consola** for human CLI output. Never conflate the two.
- **MUST NOT** log secrets or large payloads on hot paths.

## Loading

- **SHOULD** lazy-import heavy dependencies inside the handler that needs them, so the CLI cold-start stays fast (e.g. import a prompt/wizard lib only when an interactive command runs).

## Measuring

- **SHOULD** add `vitest bench` only for genuinely hot paths: credential encrypt/decrypt, MCP tool dispatch, sandbox spawn. Latency matters there (idea §9).
- **MUST NOT** add standing APM/flamegraph/profiler infra speculatively. Pull those out ad hoc when a real slowness appears.
- **SHOULD** add `size-limit` budgets only at the bundle (CLI/web) increment, not before.
