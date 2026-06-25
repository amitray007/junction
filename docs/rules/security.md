# Security Rules

Junction holds the user's credentials. These rules are non-negotiable.

## Credential plaintext

- Credential plaintext **MUST** exist only in memory, only during a tool call.
- **MUST NOT** be logged (pino redaction honored), put in error messages, persisted in the main DB, serialized into config, or returned over an MCP endpoint.
- The main DB stores a **reference/handle** to a secret, never the plaintext. Actual ciphertext lives via the `CredentialStore` (OS keyring or AES-256-GCM encrypted file).

## Encryption

- File-store secrets **MUST** be AES-256-GCM with a key from a strong KDF (scrypt/argon2), unique IV/nonce per encryption, and verified auth tag on decrypt.
- Store selection (keyring vs encrypted file) is by environment capability, with a safe headless fallback.

## Master-key threat-model scoping (Tier 3 — auto-generated key)

The **default** (zero-config) master key is auto-generated as `~/.junction/master.key` (mode 0600).
This file lives **next to** `credentials.enc.json` in the same directory.

**What this does NOT protect against:** an attacker who can read `~/.junction` — they get both
`master.key` and `credentials.enc.json` together and can decrypt all secrets.

**What it DOES guarantee:**
- (a) The main DB leaking is harmless — it holds only opaque `secret_ref` handles (ULIDs), never plaintext.
- (b) Backup/partial/accidental exposure of the DB alone (screenshot, `git add .`, bug-report copy,
  log line) **never leaks secrets** — ciphertext without the key is useless.

**For real at-rest protection** against full-disk or `~/.junction`-directory compromise, the operator
must supply a Tier-1 key (env var or file not stored on the same disk):
- `JUNCTION_MASTER_KEY=<base64-or-hex-32-bytes>` — raw key, suitable for systemd `Environment=`.
- `JUNCTION_MASTER_KEY_FILE=$CREDENTIALS_DIRECTORY/junction-key` — file path; works with
  systemd `LoadCredential=junction-key:/path/to/key` (keeps the key out of the process env).
- Either env var also accepts a human passphrase (run through scrypt N=131072) if it doesn't
  decode to exactly 32 bytes.

**Do not oversell Tier 3 as at-rest encryption** — document this honestly in `--help` and the web UI.

## Banned APIs

- **MUST NOT** use `node:vm` or `vm2` as a sandbox (not security boundaries; vm2 has active RCEs). Sandbox = Deno + bubblewrap/Seatbelt (design spec §6b).
- **MUST NOT** `eval` untrusted input.

## Boundaries

- All external input validated with Zod before use.
- MCP tool results **MUST NOT** contain credential values; secrets injected at call time stay server-side.

## Enforcement

The boundary-guard hook blocks `node:vm`/`vm2` and obvious violations pre-edit; the `junction-credential-security` reviewer (active from increment 6) audits the credential layer in depth.

## See also

- [`docs/rules/licensing.md`](./licensing.md) — SPDX header policy and AGPL §13 network-source-offer requirement (the compliance layer alongside these credential rules).
