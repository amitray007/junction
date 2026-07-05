// SPDX-License-Identifier: AGPL-3.0-only
// buildHttpInputSchema unit tests — pure function, no server needed.

import type { HttpRequestTool } from "@junction/core"
import { describe, expect, it } from "vitest"
import { buildHttpInputSchema } from "../tools.js"

function makeTool(overrides: Partial<HttpRequestTool> = {}): HttpRequestTool {
  return {
    name: "t",
    description: "d",
    method: "GET",
    path: "/x",
    params: [],
    ...overrides,
  }
}

describe("buildHttpInputSchema", () => {
  it("maps string/number/boolean/enum types", () => {
    const tool = makeTool({
      params: [
        { name: "s", in: "query", type: "string", required: false },
        { name: "n", in: "query", type: "number", required: false },
        { name: "b", in: "query", type: "boolean", required: false },
        { name: "e", in: "query", type: "enum", required: false, enum: ["a", "b"] },
      ],
    })
    const schema = buildHttpInputSchema(tool) as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(schema.properties.s).toEqual({ type: "string" })
    expect(schema.properties.n).toEqual({ type: "number" })
    expect(schema.properties.b).toEqual({ type: "boolean" })
    expect(schema.properties.e).toEqual({ type: "string", enum: ["a", "b"] })
  })

  it("surfaces anchored pattern + maxLength for string params", () => {
    const tool = makeTool({
      params: [
        {
          name: "code",
          in: "path",
          type: "string",
          required: true,
          pattern: "[A-Z]{3}",
          maxLength: 3,
        },
      ],
    })
    const schema = buildHttpInputSchema(tool) as {
      properties: Record<string, Record<string, unknown>>
      required: string[]
    }
    expect(schema.properties.code).toEqual({
      type: "string",
      pattern: "^(?:[A-Z]{3})$",
      maxLength: 3,
    })
    expect(schema.required).toEqual(["code"])
  })

  it("sets additionalProperties:false and only lists required params", () => {
    const tool = makeTool({
      params: [
        { name: "required1", in: "query", type: "string", required: true },
        { name: "optional1", in: "query", type: "string", required: false },
      ],
    })
    const schema = buildHttpInputSchema(tool) as {
      required: string[]
      additionalProperties: boolean
    }
    expect(schema.required).toEqual(["required1"])
    expect(schema.additionalProperties).toBe(false)
  })

  it("forwards param description", () => {
    const tool = makeTool({
      params: [
        { name: "q", in: "query", type: "string", required: false, description: "search term" },
      ],
    })
    const schema = buildHttpInputSchema(tool) as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(schema.properties.q.description).toBe("search term")
  })
})
