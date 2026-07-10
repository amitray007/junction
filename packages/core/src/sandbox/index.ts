// SPDX-License-Identifier: AGPL-3.0-only
// Narrow barrel — public surface of the sandbox module.

// hasUnsafePathChars is reused by schema/cli-connection.ts (32.13 Slice D1) to
// metachar-check argv[0]'s literal value at author-time — the SAME check
// validatePolicy already applies to readPaths/writePaths/cwd, restoring
// security.md's "all profile inputs metachar-checked centrally" invariant.
export { hasUnsafePathChars } from "./policy.js"
export type {
  Sandbox,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxResult,
} from "./sandbox.js"
export { createSandbox, validatePolicy } from "./sandbox.js"
