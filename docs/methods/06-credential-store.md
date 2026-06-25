# Method File 06 — CredentialStore (Increment 6)

> **The security-critical heart of the broker.** Gives the `secret_ref` (stored since inc 5) its meaning: a `CredentialStore` that maps a handle → the actual secret, encrypted at rest. Two impls — `KeyringStore` (@napi-rs/keyring) and `EncryptedFileStore` (AES-256-GCM) — selected by environment. Plaintext exists only in memory; never logged, persisted in the DB, or returned over MCP.
>
> **Builder:** Sonnet, but with **maximum care** — a credential layer with an IV-reuse or missing-auth-tag mistake is a real vulnerability. The design below is empirically verified (the keyring API + scrypt behavior were run on the target machine). **The `junction-credential-security` reviewer (stubbed since inc 0) ACTIVATES for this increment — its review is mandatory.**

---

## Part 1 — Spec (what & why)

### Goal

Implement `CredentialStore` in `@junction/core` with two backends and runtime selection, so secrets are stored encrypted-at-rest and resolved by the opaque `secret_ref` the `credentials` table already holds. Realizes design spec §6 increment 6 + `docs/rules/security.md`. Proof: secrets round-trip; **plaintext never lands on disk** (test-proven across the whole home dir); auth-tag tampering → error, never plaintext.

### Interface (Result-returning — match codebase conventions)

```ts
// the secretRef is the opaque ULID handle the DB's credentials.secret_ref column stores (inc 5).
export interface CredentialStore {
  get(secretRef: string): ResultAsync<string | null, CredentialError>  // null = no such secret (NOT an error)
  set(secretRef: string, secret: string): ResultAsync<void, CredentialError>
  delete(secretRef: string): ResultAsync<void, CredentialError>        // idempotent: deleting absent ⇒ ok
}
export function createCredentialStore(
  paths: JunctionPaths,
  env?: NodeJS.ProcessEnv,
): ResultAsync<CredentialStore, CredentialError>  // runs selection + master-key resolution
```
`CredentialError` (add to `errors/index.ts`, mirroring `DbError`/`ConfigError`):
`| { kind: "store-unavailable"; cause } | { kind: "decrypt-failed"; cause } | { kind: "key-unavailable"; cause } | { kind: "io-failed"; cause }`.

> **`get` returns `null` for a missing ref, not `Err`** — mirrors the verified keyring null-mapping and the inc-2 config ENOENT-as-default idiom.

### KeyringStore (@napi-rs/keyring v1.3) — verified API

- Use the **sync `Entry` class**: `new Entry("junction", secretRef)` → `.getPassword(): string | null`, `.setPassword(s)`, `.deleteCredential(): boolean`. (Wrap the sync calls in `ResultAsync`; lazy-import the native module like `proper-lockfile` in config.)
- **Service = `"junction"` (fixed); account = the opaque `secretRef`** (never platform/profile name — so rename/rotate never orphans a secret; globally unique on the OS keyring).
- **Missing entry → `getPassword()` returns `null`** (the napi binding maps Rust `NoEntry` → null). **A THROW means the keyring is unavailable/locked** (`NoStorageAccess`/`PlatformFailure`) → map to `store-unavailable` Err. Do NOT string-match the message for control flow.
- `delete` of an absent entry: idempotent → `ok`.

### EncryptedFileStore (AES-256-GCM via node:crypto) — verified construction

- **Algorithm:** `createCipheriv("aes-256-gcm", key32, iv12)`. **32-byte key** (the master key, §master-key). **Fresh 12-byte random IV per `set()`** (`randomBytes(12)`) — never reuse an IV with the same key. **16-byte auth tag** from `getAuthTag()`. **AAD = the `secretRef`** (`setAAD(Buffer.from(secretRef))` on encrypt AND decrypt) so ciphertexts can't be swapped between handles.
- **Decrypt:** `setAuthTag(tag)` **before** `final()`; a mismatch makes `final()` **throw** → return `decrypt-failed` Err, **never partial plaintext**. Never catch-and-return-plaintext.
- **On-disk format:** one file `~/.junction/credentials.enc.json` (mode **0600**), a map keyed by `secretRef`, each value `{ iv, tag, ct }` base64; a `v` version field; and (only when the key is passphrase-derived) a `kdf` header with `{ algo:"scrypt", N, r, p, salt }` (salt is not secret). The **master key is NEVER in this file.** Reuse config's **locked atomic write** (lock home dir, write `.tmp`, `rename`, then `chmod 0600`).

### Master key resolution (the hard problem — decided, honest scoping)

A tiered resolver, strict priority — implement exactly:
1. **`JUNCTION_MASTER_KEY` (or `JUNCTION_MASTER_KEY_FILE`)** — explicit operator key. Accept base64/hex decoding to **exactly 32 bytes** (validate → else `key-unavailable`), OR treat as a human passphrase run through scrypt. This is the **documented hardening path** (supports systemd `LoadCredential` via `JUNCTION_MASTER_KEY_FILE=$CREDENTIALS_DIRECTORY/junction-key`).
2. **OS keyring holds the master key** (`Entry("junction","__master_key__")`) — when keyring is usable (mainly the desktop hybrid / persisting an auto-key).
3. **Auto-generated random 32-byte key** at `~/.junction/master.key` (mode **0600**), generated once with `randomBytes(32)` — the **zero-config default** so headless "just works".
4. **Passphrase prompt** (interactive only) — scrypt-derived; not for unattended boot unless combined with (1).

> **HONEST THREAT-MODEL SCOPING — document this plainly (in `docs/rules/security.md` + the store's doc comment + eventually `--help`):** Tier 3 (the default key file living next to the ciphertext) does **NOT** protect against an attacker who can read `~/.junction` (they get `master.key` + `credentials.enc.json` together). What it **does** guarantee: (a) the **main DB leaking is harmless** (it holds only `secret_ref` handles); (b) **backup/partial/accidental exposure** of the DB, a screenshot, a log, a `git add .`, or a copied DB for a bug report **never leaks secrets**. For real at-rest protection against full-disk compromise, the operator supplies Tier 1 (systemd credential / passphrase not stored on the box). **Do not oversell the default as at-rest encryption.**

### KDF: scrypt (node:crypto built-in — no argon2 dep)

- `crypto.scrypt(passphrase, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })` — **async**, wrapped in `ResultAsync` (no sync in core). 16-byte random salt stored in the file header.
- **CRITICAL gotcha (verified):** at `N=2^17`, Node's default `maxmem` (32 MiB) **throws** "memory limit exceeded". You MUST pass `maxmem: 256*1024*1024`. ~294 ms once per boot — acceptable. (A test that only uses weak params would miss this — test with the real params.)

### Runtime store selection

```
selectStore(env):
  JUNCTION_STORE=="file"    → EncryptedFileStore   (explicit; for CI/tests/Docker)
  JUNCTION_STORE=="keyring" → KeyringStore          (explicit; Err if probe fails)
  else (auto):  keyringUsable("junction") ? KeyringStore : EncryptedFileStore
```
- **Probe** (`keyringUsable`): `try { new Entry("junction","__junction_probe__").getPassword(); return true } catch { return false }`. `getPassword` on a never-written account is **read-only, writes nothing, no prompt** — clean probe. Run **once** at construction, cache.
- **Auto by default** (desktop→keyring, server→file) with the explicit `JUNCTION_STORE` escape hatch (keeps the scriptable/headless path deterministic — `docs/rules`).

### Small visible surface (so the increment is visually testable)

Extend `junction status` to show the **selected credential-store backend** (e.g. `credential store: keyring` or `credential store: encrypted-file (auto-generated key)`) — exposes **no secret**, but lets the user *see* which backend is active (and, honestly, whether their secrets are keyring- vs file-backed). Add to both human + `--json` output. This is the only user-facing change; storing a credential happens at platform-connect (post-foundation).

### New deps

- `@napi-rs/keyring@^1.3` (runtime, **native** → add to root `pnpm.onlyBuiltDependencies` alongside better-sqlite3). node:crypto is built-in (no dep).

### Proof of done

- `pnpm verify` with security tests (temp `JUNCTION_HOME`):
  - round-trip (set→get) for **both** stores (`JUNCTION_STORE=file` always; `JUNCTION_STORE=keyring` gated on a usable keyring / skipped in CI);
  - **plaintext-never-on-disk:** after `set(ref, "SUPER_SECRET")`, (a) the raw bytes of `credentials.enc.json` do NOT contain the secret + the record is `{iv,tag,ct}`; (b) **whole-home scan** — walk every file under `JUNCTION_HOME` and assert the literal appears in none;
  - **tamper test:** flip a byte of `ct`/`tag` → `get()` returns `decrypt-failed`, never plaintext;
  - **perms:** `credentials.enc.json` + `master.key` are 0600, home is 0700 (gate on `process.platform !== "win32"`);
  - missing ref → `ok(null)`; `delete` idempotent;
  - the scrypt path uses the **real params** (so the maxmem trap is exercised).
- `junction status` shows the backend (human + `--json`); a child-process smoke test.
- `pnpm depcruise` clean; `pnpm build` (native keyring builds); CI green.
- SPDX headers; committed; PR green.

### Out of scope

- Connecting real platforms / actually populating credentials (post-foundation) — inc 6 is the store + tests + the status surface. OAuth token storage (later). The sandbox (7/8), TUI (9). Key *rotation* (future).

---

## Part 2 — Implementation (step by step)

### Step 1 — paths + perms

`core/src/paths/index.ts`: add `credentialsFile` (`<home>/credentials.enc.json`) + `masterKeyFile` (`<home>/master.key`) to `JunctionPaths`/`getPaths()`. `ensureHome` should create the home with mode **0700** (`mkdir(home, { recursive: true, mode: 0o700 })` + a `chmod` to be deterministic on POSIX). Update the paths test.

### Step 2 — `CredentialError` + the interface

Add `CredentialError` to `errors/index.ts`. Create `core/src/credentials/store.ts` with the `CredentialStore` interface + `createCredentialStore`. (New `credentials/` module folder — named, single-purpose; NOT a grab-bag.)

### Step 3 — master-key resolver (`core/src/credentials/master-key.ts`)

Implement the 4-tier resolver (§master-key) returning `ResultAsync<Buffer, CredentialError>` (a 32-byte key). scrypt via async `crypto.scrypt` with the real params + `maxmem`. Validate env-key length (decode base64/hex → exactly 32 bytes). Auto-generate + persist the Tier-3 key 0600 atomically. **Note on key-material scrubbing:** intermediate `Buffer` values (e.g. a decoded salt) may be zeroed if a dedicated intermediate exists; however JS strings (passphrase input) cannot be scrubbed — do NOT claim string zeroing happens. The live key Buffer itself must not be zeroed — it is the key in active use. Lazy-import nothing native here (crypto is built-in).

### Step 4 — `EncryptedFileStore` (`core/src/credentials/encrypted-file-store.ts`)

AES-256-GCM per §EncryptedFileStore. Load/parse the enc-file (ENOENT → empty map, like config). `set`: encrypt (fresh IV, AAD=ref, tag), upsert into the map, **locked atomic write + chmod 0600**. `get`: decrypt (setAuthTag before final; throw → `decrypt-failed`). `delete`: remove key, atomic write; absent → ok. All `ResultAsync`. No `fs.*Sync`. Never log the map/key/values; never put secret values in error `cause`.

### Step 5 — `KeyringStore` (`core/src/credentials/keyring-store.ts`)

Wrap `@napi-rs/keyring`'s sync `Entry` (lazy-import). `get`: `getPassword()` → null⇒`ok(null)`, value⇒`ok(value)`, throw⇒`store-unavailable`. `set`/`delete` similar; delete-absent idempotent. Service `"junction"`, account = `secretRef`.

### Step 6 — selection (`core/src/credentials/index.ts` → `createCredentialStore`)

The `keyringUsable` probe (cached) + `JUNCTION_STORE` override + auto logic (§selection). Return the chosen store. Barrel: export `CredentialStore`, `createCredentialStore`, `CredentialError` through `core/src/index.ts` (narrow, named).

### Step 7 — `junction status` shows the backend

In `core`, expose a way to report the selected backend WITHOUT exposing secrets (e.g. `createCredentialStore` returns a store with a `.backend: "keyring" | "encrypted-file"` tag, or a separate `describeCredentialBackend(env)` pure function). `status.ts` calls it and adds `credentialStore` to the human + `--json` output. Edge stays thin.

### Step 8 — deps, tests, verify, build

- `pnpm add --filter @junction/core @napi-rs/keyring@^1.3`; add `@napi-rs/keyring` to root `pnpm.onlyBuiltDependencies`; `pnpm install`.
- Tests per Proof-of-done (use a unique service/account in keyring tests + `delete` in teardown so they self-clean; gate keyring tests on availability).
- `pnpm verify`; `pnpm build` (confirm native keyring binary builds); the built `junction status` shows the backend; `pnpm depcruise`.
- Add the master-key threat-model scoping note to `docs/rules/security.md`. SPDX headers. Commit; push; PR (base main): "feat: CredentialStore — keyring + AES-256-GCM file store (increment 6)".

---

## Review (background, after build) — security-critical, extra rigor

- **`junction-credential-security` (ACTIVATES this increment — mandatory):** AES-GCM correctness (fresh IV per set, auth-tag verified before final, AAD bound, 32-byte key, no CBC/`createCipher`); master-key resolution + the honest threat-model scoping; no plaintext logged/in-error-cause/on-disk; keyring null-vs-throw split; perms 0600/0700; the scrypt params + maxmem.
- Junction: `junction-package-boundary`, `junction-clean-code-reviewer` (secrets-as-references; Result discipline; narrow barrel; no `fs.*Sync`; lazy native import; edge-thin status change).
- CE: `ce-security-reviewer` (exploitability — IV reuse, tamper, key co-location, env-var leakage), `ce-correctness-reviewer` (store selection, ENOENT/empty-map, idempotent delete, the maxmem trap), `ce-testing-reviewer` (the whole-home plaintext scan, tamper test, both-store coverage, perms asserts).
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

Close with: **visually testable — YES (small):** `junction status` now shows the credential-store backend (`keyring` / `encrypted-file`) — provide the commands; note no secret is exposed and there's nothing to *store* via CLI yet (platform-connect is post-foundation), so the deeper proof is the test suite. **QA'd by me:** drove the built status; round-trip + the plaintext-never-on-disk whole-home scan + tamper test against the built store; confirmed perms; both backends. **Checklist:** AES-GCM construction, IV-per-write, auth-tag tamper→Err, AAD binding, master-key tiers + honest scoping, scrypt maxmem, keyring null/throw split, perms 0600/0700, no plaintext on disk, native keyring in onlyBuiltDependencies.

## User test gate

`pnpm build`, then `JUNCTION_HOME=/tmp/jt6 node packages/cli/dist/index.js init && ... status` — see the `credential store:` line (keyring on your Mac, or set `JUNCTION_STORE=file` to see the encrypted-file path). Approve before increment 7 (mcp/server shell).
