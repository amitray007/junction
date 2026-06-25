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

## Sandbox (increment 8+)

- **Refuse-if-unavailable:** no enforceable backend on the platform → **`Err`, never raw `spawn`**. This is the most important property. Never silently degrade to unsandboxed execution.
- **Two co-equal backends:** Deno (`runScript`) sandboxes JS/TS; Seatbelt/bubblewrap (`runCommand`) sandboxes native CLIs. Neither is a fallback for the other.
- **No secrets in sandbox:** spawn with an EXPLICIT `env:` object from `policy.env` only — never inherit `process.env`. Validate `policy.env` at the boundary: reject any key matching `JUNCTION_MASTER_KEY`, `JUNCTION_MASTER_KEY_FILE`, `*_TOKEN`, `*_SECRET`, `*_KEY` → `policy-invalid`. The CredentialStore is NEVER passed to a sandbox.
- **`shell: false` always, argv as an array** — no shell injection surface.
- **Seatbelt profile (macOS):** use `(allow file-read*)` (broad — dyld needs it), then `(deny file-read* (subpath <CREDENTIAL_DIR>))` for the confidentiality boundary. A naive deny-all-read profile SIGABRTs every binary (exit 134). Profile temp files written at 0600, unlinked in `finally`. Invoke as `sandbox-exec -f <file> --`.
- **Seatbelt paths must be realpath-resolved** — macOS `os.tmpdir()` returns `/var/folders/...` but the kernel sees `/private/var/folders/...`. Seatbelt matches on real paths; symlink paths silently fail.
- **Seatbelt deprecation (known dependency):** Apple deprecated the `sandbox-exec` CLI (not the kernel sandbox). It still ships and is honored. The escalation path is microVMs (Containerization.framework / libkrun). The `Sandbox` interface is designed for a microVM backend to drop in behind the same `runCommand` surface.
- **Deno mandatory deny flags:** `--deny-run` and `--deny-ffi` are MANDATORY on every `deno run` invocation — these are the documented escape hatches. Also apply `--deny-sys` and `--deny-import`. Pass `--no-prompt` (missing perm = hard error, never interactive). Write `{code}` to a temp `.ts` file — never `deno eval`, never a shell string.
- **Deno binary path:** resolve the full path to `deno` at probe time so spawning with a scrubbed env (no `PATH`) still works.
- **bubblewrap (Linux):** use `--unshare-all` (network OFF), `--clearenv` + per-key `--setenv`. Probe userns at runtime; if it fails → refuse (no raw exec).
- **Denied op = nonzero exitCode, not a SandboxError.** A blocked read/write/net surfaces as a nonzero `exitCode` in `ok(SandboxResult)`. `SandboxError` is only for "couldn't run the sandbox at all."

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
