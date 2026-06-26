// SPDX-License-Identifier: AGPL-3.0-only
// operation.ts — parse-based operation-type enforcement.
//
// THE LOAD-BEARING NOVELTY: operation type is determined by parsing the document
// with graphql-js, not by trusting the transport or tool name alone. This makes
// read-only profiles a REAL guarantee: a mutation document sent through
// graphql_query is rejected here, not just at the proxy toolFilter.
//
// SOURCE-AGNOSTIC: no vendor-specific code.

import type { UpstreamError } from "@junction/core"
import { err, ok, type Result } from "@junction/core"
import type { OperationDefinitionNode } from "graphql"
import { parse } from "graphql"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperationType = "query" | "mutation" | "subscription"

// ---------------------------------------------------------------------------
// selectOperation — pick the right OperationDefinitionNode from a parsed doc
// ---------------------------------------------------------------------------

/**
 * Select the OperationDefinitionNode to execute.
 *
 * If `operationName` is provided, find that specific operation.
 * Otherwise, use the single operation in the document (multi-op without
 * operationName is a GraphQL spec error — we surface it as invalid-args).
 */
function selectOperation(
  defs: readonly OperationDefinitionNode[],
  operationName: string | undefined,
): Result<OperationDefinitionNode, UpstreamError> {
  if (operationName !== undefined && operationName !== "") {
    const found = defs.find((d) => d.name?.value === operationName)
    if (!found) {
      return err<OperationDefinitionNode, UpstreamError>({
        kind: "invalid-args",
        reason: `operationName "${operationName}" not found in the document`,
      })
    }
    return ok(found)
  }

  if (defs.length === 0) {
    return err<OperationDefinitionNode, UpstreamError>({
      kind: "invalid-args",
      reason: "document contains no operation definitions",
    })
  }

  if (defs.length > 1) {
    return err<OperationDefinitionNode, UpstreamError>({
      kind: "invalid-args",
      reason: "document contains multiple operations — provide operationName to select one",
    })
  }

  // Length === 1 is proven by the guards above; the cast is safe.
  return ok(defs[0] as OperationDefinitionNode)
}

// ---------------------------------------------------------------------------
// getOperationType — parse and select, return the operation type string
// ---------------------------------------------------------------------------

/**
 * Parse `query` (GraphQL document string) and return the type of the selected
 * operation ("query" | "mutation" | "subscription"), or an invalid-args error
 * on syntax error, no operations, or ambiguous multi-op without operationName.
 */
export function getOperationType(
  query: string,
  operationName: string | undefined,
): Result<OperationType, UpstreamError> {
  let doc: ReturnType<typeof parse>
  try {
    doc = parse(query)
  } catch (cause) {
    return err<OperationType, UpstreamError>({
      kind: "invalid-args",
      reason: `GraphQL syntax error: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
  }

  const opDefs = doc.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === "OperationDefinition",
  )

  const selected = selectOperation(opDefs, operationName)
  if (selected.isErr()) return err(selected.error)

  return ok(selected.value.operation as OperationType)
}

// ---------------------------------------------------------------------------
// assertOperationType — enforce expected type, reject subscription
// ---------------------------------------------------------------------------

/**
 * Parse `query`, select the operation (by operationName or first/only), and
 * assert that its type matches `expected`.
 *
 * Returns Ok(void) on success. Returns invalid-args on:
 *   - syntax error
 *   - no operation / ambiguous multi-op (no operationName)
 *   - operationName not found
 *   - type mismatch (e.g. mutation sent to graphql_query)
 *   - subscription (no transport)
 */
export function assertOperationType(
  query: string,
  operationName: string | undefined,
  expected: "query" | "mutation",
): Result<void, UpstreamError> {
  const typeResult = getOperationType(query, operationName)
  if (typeResult.isErr()) return err(typeResult.error)

  const actual = typeResult.value

  if (actual === "subscription") {
    return err<void, UpstreamError>({
      kind: "invalid-args",
      reason:
        "subscription operations are not supported — use graphql_query for queries or graphql_mutation for mutations",
    })
  }

  if (actual !== expected) {
    return err<void, UpstreamError>({
      kind: "invalid-args",
      reason: `expected a ${expected} operation but got ${actual} — use the correct tool (graphql_query / graphql_mutation)`,
    })
  }

  return ok(undefined)
}
