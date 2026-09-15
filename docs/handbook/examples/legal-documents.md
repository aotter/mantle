---
description: Localized Terms and Privacy documents with immutable revisions, public lookup and signed-in acceptance records.
---
# Legal documents and consent

This example gives an application a portable shape for Terms of Use, Privacy Policy and consent receipts. It uses existing Mantle atoms. Core does not install it or own the public pages.

Each `(kind, revision, locale)` row is one legal artifact. Publish a new row for a new legal revision; do not overwrite a published row whose id appears in acceptance records. The English Schema description is also the MCP and WebMCP authoring instruction.

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
  name: require-published-legal-document
spec:
  title: Require a published legal document
  input:
    type: object
    additionalProperties: false
    required: [documentId]
    properties:
      documentId: { type: string, format: uuid, x-mantle-ref: legal-documents }
  output: { type: object }
  handler: { kind: ref, ref: require-published-legal-document }
  requires: { auth: { all: [ctx.user] } }
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
    en: Record the signed-in user's acceptance of one published legal document revision.
    zh-TW: 記錄登入使用者對一份已發佈法律文件修訂的同意。
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
    guard: { procedure: require-published-legal-document }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: accept-legal-document-http
spec:
  source: { kind: http, method: POST, path: /api/legal/acceptances }
  target: { procedure: accept-legal-document }
```

The guard is application code because only the application owns its database and retention policy:

```ts
export async function requirePublishedLegalDocument(
  { documentId }: { documentId: string },
  ctx: HandlerContext<{ DB: D1Database }>,
) {
  const row = await ctx.env.DB.prepare(
    "SELECT 1 FROM entries WHERE id = ? AND collection = 'legal-documents' AND status = 'published'",
  ).bind(documentId).first();
  if (!row) throw new Error("published_legal_document_required");
  return {};
}
```

Register it under the manifest ref name `require-published-legal-document`. The HTTP endpoint then records only `documentId`; `userId` and `acceptedAt` are server-bound and cannot be supplied by the caller.

Serve `/terms` and `/privacy` in application code by querying `current-legal-document` with the requested locale, falling back to the site's default locale, and rendering Markdown as escaped/sanitized HTML. Return a clear unavailable page when no reviewed document is published. The application also owns the checkbox or other consent UI, authentication, retention and export policy.

Staff MCP and Admin WebMCP automatically expose `create_draft_legal_documents` and `update_draft_legal_documents`. Both descriptions include the Schema description above, so agents are told to collect real reviewed text rather than inventing it. Do not add an MCP Trigger for `accept-legal-document`: accepting legal terms is an explicit user-interface action.

## Source

- [Publication](./publication.md) — localized publishing pattern
- [Authorization](../reference/authorization.md) — server-bound identity and guard Procedures
- [MCP and agents](../concepts/mcp-and-agents.md) — manifest-derived tool contracts
