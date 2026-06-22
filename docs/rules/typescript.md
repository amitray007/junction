# TypeScript Rules

The only language in the foundation. Each rule is a checkable MUST / MUST-NOT.

## Errors

- **MUST** return neverthrow `Result<T, E>` from any operation that can fail. **MUST NOT** `throw` across a module or package boundary. (Throwing inside a single function before it returns a `Result` is fine; the boundary is what matters.)
- **MUST** model domain errors as discriminated unions, e.g.:
  ```ts
  type CredentialError =
    | { kind: "decryption-failed"; cause: unknown }
    | { kind: "key-not-found"; account: string }
    | { kind: "storage-failed"; cause: unknown };
  ```
- **MUST** consume every returned `Result` — no floating results. Handle both `ok` and `err`, or explicitly propagate.
- **MAY** use `p-retry` (or a small helper) for retryable operations. Do **not** reach for Effect-TS (see design spec §5a).

## Types

- **MUST NOT** use `any` in `core`. Prefer `unknown` + narrowing. (`any` at a hostile third-party boundary must be narrowed immediately.)
- **MUST NOT** use non-null assertions (`!`) in `core`. Honor `noUncheckedIndexedAccess`.
- **MUST** validate all external input with **Zod** at trust boundaries (config load, MCP/API inputs, OAuth responses). Inside the boundary, pass typed values, not raw input.
- **SHOULD** derive types from a single source (Zod `z.infer`, Drizzle `$inferSelect`) rather than duplicating shapes.

## Resources

- **SHOULD** use `using` / `Symbol.asyncDispose` (TS 5.2) for resources needing guaranteed cleanup, instead of ad-hoc try/finally where a disposable fits.

## Structure

- **MUST** keep one clear responsibility per file/unit. If a file does two jobs or grows past easy readability, split it.
- **MUST** respect the dependency direction: `core` imports nothing from `cli`/`web`/`mcp/*`. No HTTP server/daemon in `core`. (Enforced by the boundary-guard hook + `junction-package-boundary`.)
- **MUST NOT** deep-import another package's internals; import from its public entry.

## Modules & naming

- ESM-only, `nodenext`. **MUST** use explicit extensions where resolution requires.
- **MUST** use intention-revealing names; no abbreviations that aren't domain terms.
- Tool names: `<namespace>__<tool>` (double underscore). MCP endpoints: `/profiles/{name}/mcp`.
