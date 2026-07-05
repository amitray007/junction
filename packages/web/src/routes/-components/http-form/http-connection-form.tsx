// SPDX-License-Identifier: AGPL-3.0-only
// HttpConnectionForm — the guided HTTP descriptor form: baseUrl, a default-
// headers repeater, and a list of request-tool cards. Auth is intentionally
// NOT part of this form — it's the shared connection-level auth-scheme
// Select rendered once in platforms.tsx for openapi/graphql/http alike (see
// PlatformDialog); this form is METADATA-ONLY and secret-free, matching the
// cli-form's own credentialEnvVar-only (no token) shape.

import { Field, Input } from "../../../ui/index.js"
import { KeyValueRepeater } from "../key-value-repeater.js"
import { ToolCardList } from "../tool-card-list.js"
import { HttpToolCard } from "./http-tool-card.js"
import type { HttpConnectionFormState } from "./types.js"
import { emptyHeaderRow, emptyHttpTool } from "./types.js"

interface HttpConnectionFormProps {
  readonly connection: HttpConnectionFormState
  readonly onChange: (connection: HttpConnectionFormState) => void
  readonly baseUrlError?: string
  readonly toolErrors?: Record<number, Record<string, string>>
}

export function HttpConnectionForm({
  connection,
  onChange,
  baseUrlError,
  toolErrors,
}: HttpConnectionFormProps) {
  return (
    <div className="flex flex-col gap-4">
      <Field
        id="http-base-url"
        label="Base URL"
        error={baseUrlError}
        description="Host-pinned — agent args never set the host, only path/query/body values."
      >
        <Input
          id="http-base-url"
          placeholder="https://api.example.com"
          value={connection.baseUrl}
          onChange={(e) => onChange({ ...connection, baseUrl: e.target.value })}
          hasError={!!baseUrlError}
          aria-required="true"
        />
      </Field>

      <KeyValueRepeater
        label="Default Headers"
        rows={connection.defaultHeaders}
        onChange={(defaultHeaders) => onChange({ ...connection, defaultHeaders })}
        keyPlaceholder="Header-Name"
        addLabel="Add Header"
        removeAriaLabel="Remove header"
        collapsible
        defaultExpanded={connection.defaultHeaders.length > 0}
        makeRow={() => emptyHeaderRow()}
      />

      <ToolCardList
        tools={connection.tools}
        onChange={(tools) => onChange({ ...connection, tools })}
        toolErrors={toolErrors}
        makeTool={emptyHttpTool}
        addLabel="Add Request Tool"
        renderCard={(props) => <HttpToolCard key={props.tool.key} {...props} />}
      />
    </div>
  )
}
