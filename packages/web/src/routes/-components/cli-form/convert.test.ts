// SPDX-License-Identifier: AGPL-3.0-only
// convert.ts tests — focused on connectionFromDetail's cliMode propagation
// (increment 41.5): the platform detail DTO's `cliMode` must carry through to
// the form state unchanged, since platforms.tsx's submit dispatch (declared
// updatePlatformFn vs full-access setFullAccessCliShortcutsFn) branches on it.

import { describe, expect, it } from "vitest"
import { connectionFromDetail } from "./convert.js"

describe("connectionFromDetail", () => {
  it("defaults to declared mode when cliMode is absent (legacy/undefined)", () => {
    const state = connectionFromDetail({ cliTools: [] })
    expect(state.mode).toBe("declared")
  })

  it('propagates cliMode:"declared" explicitly', () => {
    const state = connectionFromDetail({ cliMode: "declared", cliTools: [] })
    expect(state.mode).toBe("declared")
  })

  it('propagates cliMode:"full-access" so the edit dialog renders the shortcuts surface', () => {
    const state = connectionFromDetail({ cliMode: "full-access", cliTools: [] })
    expect(state.mode).toBe("full-access")
  })

  it("maps cliTools (which project shortcuts[] for a full-access platform) into state.tools", () => {
    const state = connectionFromDetail({
      cliMode: "full-access",
      cliTools: [
        {
          name: "pr_list",
          commandLine: "/usr/bin/gh pr list",
          args: [],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            network: { mode: "denied" },
            timeoutMs: 5_000,
            envAllow: {},
          },
          reversible: true,
        },
      ],
    })
    expect(state.tools).toHaveLength(1)
    expect(state.tools[0]?.name).toBe("pr_list")
    expect(state.tools[0]?.commandLine).toBe("/usr/bin/gh pr list")
  })

  it("an empty cliTools list is valid for full-access mode (zero shortcuts)", () => {
    const state = connectionFromDetail({ cliMode: "full-access", cliTools: [] })
    expect(state.tools).toEqual([])
  })
})
