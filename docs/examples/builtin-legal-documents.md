---
description: Localized Terms and Privacy documents with immutable revisions, public lookup and signed-in acceptance records.
---
# Legal documents and consent

**Handler class:** builtin · **Builder:** yes · [Examples hub](./README.md).

This example gives an application a portable shape for Terms of Use, Privacy Policy and consent receipts. The published Manifest uses only `handler.kind: builtin`. Core does not install it or own the public pages. A live “must be a published revision” check is a `ref` guard; see [Guarded API access](./cf-primitives-guarded-api.md).

Each `(kind, revision, locale)` row is one legal artifact. Immutability here is not a legal-specific Runtime: it is the generic-surface `schema.readOnly: true` pattern (Admin and Staff MCP suppress generic create, update, status and delete), the unique `(kind, revision, locale)` index, and a Procedure-only write path. Host code that calls `updateDraft` (or other mutation use cases) directly can still rewrite a row — do not expose those host mutation APIs for this collection. The English Procedure description is also the MCP and WebMCP authoring instruction.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: legal-documents
spec:
  title:
    en: Legal documents
    zh-TW: 法律文件
  description:
    en: Supply the site's complete, reviewed legal text. Never create empty, placeholder, or agent-invented terms. Create a new revision instead of rewriting a published document accepted by users.
    zh-TW: 請填入網站已審閱的完整法律正文。不得建立空白、佔位或由 agent 虛構的條款；已有使用者同意的已發佈文件應建立新修訂，不得覆寫。
  localized: true
  lifecycle: publishing
  uniqueIndexes:
    - [kind, revision, locale]
  indexes:
    - [kind, locale, effectiveAt]
  searchableFields: [title, revision]
  schema:
    type: object
    readOnly: true
    additionalProperties: false
    required: [kind, revision, locale, title, body, effectiveAt]
    properties:
      kind: { type: string, enum: [terms, privacy] }
      revision: { type: string, minLength: 1, maxLength: 100 }
      locale: { type: string }
      title: { type: string, minLength: 1, maxLength: 200 }
      body:
        type: string
        minLength: 1
        x-mcp-hint: markdown
        description:
          en: Complete reviewed legal text in Markdown; placeholders are not acceptable.
          zh-TW: 已審閱的完整 Markdown 法律正文，不得使用佔位文字。
      effectiveAt: { type: integer, minimum: 0, x-mcp-hint: timestamp-ms }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: current-legal-document
spec:
  title:
    en: Current legal document
    zh-TW: 現行法律文件
  surface: public
  from: legal-documents
  params:
    type: object
    additionalProperties: false
    required: [kind, locale]
    properties:
      kind: { type: string, enum: [terms, privacy] }
      locale: { type: string }
  fields: [id, kind, revision, locale, title, body, effectiveAt, updatedAt]
  filter:
    and:
      - eq: { field: status, value: published }
      - eq: { field: kind, value: { $param: kind } }
      - eq: { field: locale, value: { $param: locale } }
  orderBy:
    - { field: effectiveAt, direction: desc }
  limit: 1
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: create-legal-document
spec:
  title:
    en: Create legal document revision
    zh-TW: 建立法律文件修訂
  description:
    en: Supply the site's complete, reviewed legal text. Never create empty, placeholder, or agent-invented terms. Create a new revision instead of rewriting a published document accepted by users.
    zh-TW: 請填入網站已審閱的完整法律正文。不得建立空白、佔位或由 agent 虛構的條款；已有使用者同意的已發佈文件應建立新修訂，不得覆寫。
  input:
    type: object
    additionalProperties: false
    required: [kind, revision, locale, title, body, effectiveAt]
    properties:
      kind: { type: string, enum: [terms, privacy] }
      revision: { type: string, minLength: 1, maxLength: 100 }
      locale: { type: string }
      title: { type: string, minLength: 1, maxLength: 200 }
      body:
        type: string
        minLength: 1
        x-mcp-hint: markdown
        description:
          en: Complete reviewed legal text in Markdown; placeholders are not acceptable.
          zh-TW: 已審閱的完整 Markdown 法律正文，不得使用佔位文字。
      effectiveAt: { type: integer, minimum: 0, x-mcp-hint: timestamp-ms }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: legal-documents }
  requires:
    auth:
      all:
        - ctx.user
        - { ctx.staff: [owner, editor] }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: create-legal-document-staff
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: create-legal-document }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: legal-acceptances
spec:
  title:
    en: Legal acceptances
    zh-TW: 法律文件同意紀錄
  description:
    en: Append-only receipts bound by the server to the signed-in user and acceptance time.
    zh-TW: 由伺服器綁定登入使用者與同意時間的唯增紀錄。
  lifecycle: operational
  uniqueIndexes:
    - [documentId, userId]
  indexes:
    - [userId, acceptedAt]
  schema:
    type: object
    readOnly: true
    additionalProperties: false
    required: [documentId, userId, acceptedAt]
    properties:
      documentId: { type: string, format: uuid, x-mantle-ref: legal-documents }
      userId: { type: string, x-mantle-bind: ctx.user }
      acceptedAt: { type: integer, x-mantle-bind: now, x-mcp-hint: timestamp-ms }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: accept-legal-document
spec:
  title:
    en: Accept legal document
    zh-TW: 同意法律文件
  description:
    en: Record the signed-in user's acceptance of one legal document revision.
    zh-TW: 記錄登入使用者對一份法律文件修訂的同意。
  input:
    type: object
    additionalProperties: false
    required: [documentId]
    properties:
      documentId: { type: string, format: uuid, x-mantle-ref: legal-documents }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: legal-acceptances }
  requires:
    auth: { all: [ctx.user] }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: accept-legal-document-http
spec:
  source: { kind: http, method: POST, path: /api/legal/acceptances }
  target: { procedure: accept-legal-document }
```

The HTTP endpoint records only `documentId`; `userId` and `acceptedAt` are server-bound and cannot be supplied by the caller. This Manifest does not include a live “row is published” guard. Add that as a `ref` Procedure on `requires.guard` when the application owns the lookup; the contract is [Guarded API access](./cf-primitives-guarded-api.md).

Serve `/terms` and `/privacy` in application code by querying `current-legal-document` with the requested locale, falling back to the site's default locale, and rendering Markdown as escaped/sanitized HTML. Return a clear unavailable page when no reviewed document is published. The application also owns the checkbox or other consent UI, authentication, retention and export policy.

Staff MCP and Admin WebMCP expose `create_legal_document` from the explicit staff Trigger. Both use the same Procedure description, so agents are told to collect real reviewed text rather than inventing it. Root `readOnly` deliberately emits no generic update tool on Admin or Staff MCP; that is a generic-surface gate, not a storage lock. Do not add an MCP Trigger for `accept-legal-document`: accepting legal terms is an explicit user-interface action.

## Source

- [Publication](./builtin-publication.md) — localized publishing pattern
- [Authorization](../handbook/reference/authorization.md) — server-bound identity
- [Guarded API access](./cf-primitives-guarded-api.md) — optional live published-document `ref` guard
- [MCP and agents](../handbook/concepts/mcp-and-agents.md) — manifest-derived tool contracts
