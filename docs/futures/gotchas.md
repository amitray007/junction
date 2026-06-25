# Gotchas — fragilities already hit, worked around, worth remembering

Non-obvious sharp edges we've already paid for. Each lists the **symptom** and the **fix in place**, so the next person (or agent) doesn't re-learn it the hard way. Roughly grouped by area.

## Sandbox (inc 8)

- **Seatbelt deny-all-read SIGABRTs every binary (exit 134).** A naive "deny default + allow only the workspace read" profile crashes the loader — dyld and the binary need broad read through `/` and the dyld shared cache. **Fix:** a broad `(allow file-read*)` with the confidentiality boundary expressed as explicit `(deny file-read* (subpath …))` lines (the credential dir + `~/.junction`). The tell is exit **134 (crash, profile too tight)** vs exit **1 (clean denial, working)** — that distinction is the whole game.
- **Seatbelt does NOT scrub environment.** A sandboxed child inherits the parent's env by default → `JUNCTION_MASTER_KEY` would leak straight through. **Fix:** the harness spawns children with an **explicit `env:` allowlist** built only from `policy.env`; never inherit `process.env`. (Verified: explicit env → child sees the secret empty.)
- **Deno permissions are a capability boundary, not a syscall jail.** `--allow-run`, `--allow-ffi`, `eval`, dynamic `import()`, and workers all escape or inherit privileges. **Fix:** always `--no-prompt --deny-run --deny-ffi`; for truly hostile code use the microVM tier, not Deno.
- **bubblewrap needs unprivileged user namespaces.** Some distros disable `CLONE_NEWUSER`. **Fix:** probe at runtime (`bwrap --ro-bind /usr /usr -- /bin/true`); if it fails, treat the platform as having no command sandbox → **refuse** (`Err`), never raw-exec.
- **The cardinal rule:** when no enforceable backend is available, **refuse** — never fall back to `child_process.spawn` unsandboxed. Silent unsandboxed fallback is the #1 way this layer becomes security theater.
- **SBPL/argv injection via unsanitized policy paths.** A granted path was interpolated raw into the Seatbelt profile (`(allow file-write* (subpath "${p}"))`) — a path containing `")) (allow …` injected *new* policy rules and escaped the workspace (proven: wrote outside, exit 0). The sandbox is *designed* to take semi-trusted input, so this is unsafe-by-construction. **Fix:** central `validatePolicy` rejects any path/cwd/allowNet entry containing SBPL/argv metachars (`"` `\` `(` `)` newline NUL `,`) → `policy-invalid`, before any profile/argv is built. Same metachar guard also blocks Deno's comma-list widening.
- **bwrap as a bare command name fails under a scrubbed env (Linux only).** `spawn("bwrap", …, {env:{}})` has no `PATH`, so Node can't resolve the bare binary → ENOENT → probe false → backend silently `"none"` → **bwrap tests skip**. Seatbelt avoided it by using the absolute `/usr/bin/sandbox-exec`. **Fix:** resolve bwrap to an absolute path via `which` once (like deno), use it for all spawns. Also: `resolveCapabilities` must actually *probe* the bwrap backend on Linux (it initially only probed seatbelt). **Lesson: a backend that only runs on a platform your dev box isn't must be exercised in CI** — local `verify` can't see it; the "tests silently skip" failure mode hides until a Linux runner proves they *ran* (assert the backend banner + non-skipped count).

## Credentials (inc 6)

- **scrypt throws at `N=2^17` under the default 32 MiB `maxmem`** (`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`). **Fix:** pass `maxmem: 256 * 1024 * 1024` explicitly. A test using weak params would miss this — test with the real params.
- **Corrupt-but-present `credentials.enc.json` must not be silently emptied.** Treating a JSON `SyntaxError` as "empty store" lets the next `set()` overwrite and destroy all ciphertext. **Fix:** only `ENOENT` → empty map; a present-but-unparseable file → `io-failed` (refuse to load/overwrite).
- **Temp files: create at `0600`, don't `chmod` after.** Writing the master key / salt tmp at the umask default then chmod-ing leaves a world-readable window on the actual key. **Fix:** `writeFile(tmp, data, { mode: 0o600 })`.

## MCP client — upstream connector (inc 11)

- **`env` on `StdioClientTransport` REPLACES the default environment.** A custom `env` object passed to `StdioClientTransport` is used verbatim — it does NOT inherit from `process.env`. If you omit `PATH` and `HOME`, the child process cannot resolve binaries or find its home directory and will fail with ENOENT or unexpected errors. **Fix:** always spread `getDefaultEnvironment()` (returns HOME, LOGNAME, PATH, SHELL, TERM, USER) first, then inject the token: `{ ...getDefaultEnvironment(), [tokenEnvVar]: secret }`. This also keeps the child env minimal — no `process.env` spill — which matches the sandbox env-scrub discipline (no `JUNCTION_MASTER_KEY` leaking to an upstream binary).

## MCP (inc 7)

- **A zero-tool `McpServer` doesn't advertise the `tools` capability** → a client's `tools/list` returns `-32601 Method not found`, not an empty list. **Fix:** use the low-level `Server` with `capabilities:{tools:{}}` + an explicit `ListToolsRequestSchema` handler returning the (profile-driven) tool list — which is also the right model for junction.
- **`stdout` on `junction mcp serve` is the MCP channel** — a single stray log line corrupts the JSON-RPC stream. **Fix:** all human/error output goes to **stderr**; never `console.log`/consola to stdout in the serve path.

## TUI (inc 9)

- **OpenTUI's native renderer is Bun-only under Node.** `@opentui/core` imports cleanly but calling `createCliRenderer()` or `createTestRenderer()` throws `"native FFI is not available for this runtime yet"` on Node 22/24 — the renderer uses `bun:ffi` internally, which is unavailable outside Bun. **Symptom:** import succeeds, first render call throws. **Fix:** use **Ink** for Node TUIs. Ink 7.x (7.1.0 here, `engines: node >=22`) is pure ESM, renders entirely in Node, and has `ink-testing-library` for headless snapshot tests. The OpenTUI revisit-when entry tracks the trigger. (inc 9)

## Boundary tooling (inc 1.5 / 3 / 7)

- **depcruise "green but blind":** resolving `@junction/*` through the `exports` map landed edges on the excluded `dist/`, so cross-package violations were silently invisible while the rules "passed". **Fix:** `tsconfig.depcruise.json` maps every specifier to `packages/*/src`, and the `cli` package (named `junction`, not `@junction/cli`) is mapped too so its boundary is governed.
- **Boundary rules must be structural, not enumerated.** Listing today's packages by name leaves a hole the moment a 6th package is added (it falls through the guard). **Fix:** "a lib = any non-app package may import only core + itself" — a new package is automatically governed. Re-verify a planted-import matrix on any rule change; the guard has needed guarding twice.

## Config / CLI (inc 2 / 3)

- **`proper-lockfile` with `realpath:true` ENOENTs on first write** (the target file doesn't exist yet). **Fix:** lock the **home directory**, not the not-yet-created file.
- **Temp filename via `Date.now()` collides under same-millisecond concurrency** → rename race → write-failed. **Fix:** `randomUUID()` for temp names.
- **`process.exit()` truncates a `--json` write on a pipe.** **Fix:** set `process.exitCode` and `return`; let the event loop flush stdout.
- **TS exhaustiveness `never`-guard via an `if`-chain (`const _x: never = e`) can break a clean `tsc -b` build** under some TS versions. **Fix:** use a `switch` with the `never` assignment in the `default` case.

## Packaging / deps

- **Drizzle migration files must be packaged into `dist`** or runtime `migrate` can't find them. **Fix:** include the migrations folder in the build output.
- **jscpd 5.x is broken** (silently scans a single file). **Fix:** pinned to 4.x.
