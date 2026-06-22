# Security Rules

Junction holds the user's credentials. These rules are non-negotiable.

## Credential plaintext

- Credential plaintext **MUST** exist only in memory, only during a tool call.
- **MUST NOT** be logged (pino redaction honored), put in error messages, persisted in the main DB, serialized into config, or returned over an MCP endpoint.
- The main DB stores a **reference/handle** to a secret, never the plaintext. Actual ciphertext lives via the `CredentialStore` (OS keyring or AES-256-GCM encrypted file).

## Encryption

- File-store secrets **MUST** be AES-256-GCM with a key from a strong KDF (scrypt/argon2), unique IV/nonce per encryption, and verified auth tag on decrypt.
- Store selection (keyring vs encrypted file) is by environment capability, with a safe headless fallback.

## Banned APIs

- **MUST NOT** use `node:vm` or `vm2` as a sandbox (not security boundaries; vm2 has active RCEs). Sandbox = Deno + bubblewrap/Seatbelt (design spec §6b).
- **MUST NOT** `eval` untrusted input.

## Boundaries

- All external input validated with Zod before use.
- MCP tool results **MUST NOT** contain credential values; secrets injected at call time stay server-side.

## Enforcement

The boundary-guard hook blocks `node:vm`/`vm2` and obvious violations pre-edit; the `junction-credential-security` reviewer (active from increment 6) audits the credential layer in depth.
