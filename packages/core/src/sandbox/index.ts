// SPDX-License-Identifier: AGPL-3.0-only
// Narrow barrel — public surface of the sandbox module.

export type {
  Sandbox,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxResult,
} from "./sandbox.js"
export { createSandbox, validatePolicy } from "./sandbox.js"
