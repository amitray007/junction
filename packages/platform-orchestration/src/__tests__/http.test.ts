// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest"
import { addHttpPlatform } from "../http.js"

function descriptorFor() {
  return {
    baseUrl: "https://api.example.com",
    tools: [
      {
        name: "getIssue",
        description: "Fetch a single issue by owner/repo/number.",
        method: "GET",
        path: "/repos/{owner}/{repo}/issues/{number}",
        params: [
          { name: "owner", in: "path", type: "string", required: true },
          { name: "repo", in: "path", type: "string", required: true },
          { name: "number", in: "path", type: "number", required: true },
        ],
      },
    ],
  }
}

describe("addHttpPlatform", () => {
  it("assembles a Platform from a valid descriptor", async () => {
    const result = await addHttpPlatform({
      id: "example-api",
      displayName: "Example API",
      descriptor: descriptorFor(),
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.platform.kind).toBe("http")
    expect(result.value.platform.http?.baseUrl).toBe("https://api.example.com")
    expect(result.value.toolCount).toBe(1)
  })

  it("a path↔param cross-check mismatch (declared path param has no placeholder) returns invalid-descriptor", async () => {
    const descriptor = descriptorFor()
    // Add an extra in:"path" param with no matching {placeholder} in `path` — the
    // HttpRequestToolSchema refine requires exact agreement both directions.
    const [tool] = descriptor.tools
    if (!tool) throw new Error("fixture must have one tool")
    tool.params.push({ name: "extra", in: "path", type: "string", required: true })

    const result = await addHttpPlatform({
      id: "mismatch-api",
      displayName: "Mismatch API",
      descriptor,
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-descriptor")
  })

  it("an empty id fails PlatformSchema's min(1) and returns invalid-platform", async () => {
    const result = await addHttpPlatform({
      id: "",
      displayName: "Bad Id API",
      descriptor: descriptorFor(),
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-platform")
  })
})
