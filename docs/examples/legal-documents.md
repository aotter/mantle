---
description: Localized Terms and Privacy documents with immutable revisions, a public lookup and signed-in acceptance records.
---
# Legal documents and consent

[Examples hub](./README.md)

A portable shape for Terms of Use, a Privacy Policy and consent receipts. Each
`(kind, revision, locale)` row is one legal artifact. Every Procedure is SQL.
Core does not install this or own the public pages.

## Problem

Staff add reviewed legal text as new revisions and publish them; a published
revision that users accepted is never rewritten. The public reads the current
revision for a kind and a locale. A signed-in user records acceptance of one
published revision, and the receipt names who and when without trusting the
caller.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: legal-documents }
spec:
  title:
    en: Legal documents
    zh-TW: 法律文件
  description:
    en: Supply the site's complete, reviewed legal text. Never create empty, placeholder, or agent-invented terms. Create a new revision instead of rewriting a published document accepted by users.
    zh-TW: 請填入網站已審閱的完整法律正文。不得建立空白、佔位或由 agent 虛構的條款；已有使用者同意的已發佈文件應建立新修訂，不得覆寫。
  localized: true
  lifecycle: publishing
  uniqueIndexes: [[kind, revision, locale]]
  indexes: [[kind, locale, effectiveAt]]
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
      effectiveAt: { type: string, format: date-time }
---
# Public over a publishing Schema: drafts are never visible here.
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: current-legal-document }
spec:
  title:
    en: Current legal document
    zh-TW: 現行法律文件
  description: The newest published revision of one legal document in one locale.
  surface: public
  input:
    type: object
    additionalProperties: false
    required: [kind, locale]
    properties:
      kind: { type: string, enum: [terms, privacy] }
      locale: { type: string }
  sql: |
    SELECT id, kind, revision, locale, title, body, effectiveAt, updated_at
    FROM "legal-documents"
    WHERE kind = input.kind AND locale = input.locale AND effectiveAt <= now()
    ORDER BY effectiveAt DESC LIMIT 1
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: create-legal-document }
spec:
  title:
    en: Create legal document revision
    zh-TW: 建立法律文件修訂
  description:
    en: Supply the site's complete, reviewed legal text. Never create empty, placeholder, or agent-invented terms. Create a new revision instead of rewriting a published document accepted by users.
    zh-TW: 請填入網站已審閱的完整法律正文。不得建立空白、佔位或由 agent 虛構的條款；已有使用者同意的已發佈文件應建立新修訂，不得覆寫。
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
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
      effectiveAt: { type: string, format: date-time }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO "legal-documents" (kind, revision, locale, title, body, effectiveAt)
      VALUES (input.kind, input.revision, input.locale, input.title, input.body, input.effectiveAt)
      RETURNING id, revision
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: create-legal-document-staff }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: create-legal-document }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: legal-acceptances }
spec:
  title:
    en: Legal acceptances
    zh-TW: 法律文件同意紀錄
  description:
    en: Append-only receipts bound by the server to the signed-in user and acceptance time.
    zh-TW: 由伺服器綁定登入使用者與同意時間的唯增紀錄。
  lifecycle: operational
  uniqueIndexes: [[documentId, userId]]
  indexes: [[userId]]
  schema:
    type: object
    readOnly: true
    additionalProperties: false
    required: [documentId, userId]
    properties:
      documentId: { type: string, x-mantle-ref: legal-documents }
      userId: { type: string }
---
# A conditional INSERT ... SELECT: it writes a receipt only for a published revision, and a repeat acceptance is ignored.
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: accept-legal-document }
spec:
  title:
    en: Accept legal document
    zh-TW: 同意法律文件
  description:
    en: Record the signed-in user's acceptance of one published legal document revision.
    zh-TW: 記錄登入使用者對一份已發佈法律文件修訂的同意。
  requires: { auth: { all: [ctx.user] } }
  input:
    type: object
    additionalProperties: false
    required: [documentId]
    properties:
      documentId: { type: string, x-mantle-ref: legal-documents }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO "legal-acceptances" (documentId, userId)
      SELECT d.id, auth.uid() FROM "legal-documents" d
      WHERE d.id = input.documentId AND d.status = 'published'
      ON CONFLICT (documentId, userId) DO NOTHING
      RETURNING id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: accept-legal-document-http }
spec:
  source: { kind: http, method: POST, path: /api/legal/acceptances }
  target: { procedure: accept-legal-document }
```

How the guarantees are made:

- **Who and when are the server's.** `accept-legal-document` writes
  `auth.uid()` as `userId`, and the acceptance time is the native
  `created_at`. The input carries only `documentId`.
- **Only a published revision can be accepted.** The `INSERT … SELECT` writes
  a row only when the document exists and is published. It is a set op, so
  writing nothing is a normal result: `results` is `[[]]` for a draft, an
  unknown id or a repeat acceptance. The client checks for a returned `id`.
- **Revisions are immutable through generic surfaces.** The root
  `readOnly: true` keeps Admin from offering generic edits, and the unique
  `(kind, revision, locale)` index makes a new revision a new row. It is not a
  storage lock: host code with `runtime.store` can still rewrite a row, so do
  not write to this Schema from your own code.
- **Agents are told not to invent terms.** The English Procedure description
  is the staff MCP tool's description.
- **`effectiveAt <= now()`** lets staff publish a revision ahead of the day it
  takes effect.

Do not add an MCP Trigger for `accept-legal-document`: accepting terms is an
explicit action in the application's own interface.

## Handlers

None.

## Serving the pages

Serve `/terms` and `/privacy` from the service's own `fetch`: with the caller
your `CallerResolver` returned, call
`runtime.store.as(caller).view("current-legal-document", { input: { kind, locale } })`
for the requested locale, fall back to the site's default
locale, and render the Markdown as sanitized HTML. Answer with a clear
unavailable page when no revision is published. The application owns the
consent checkbox, sign-in, retention and export policy.

## Source

- [Publication](./publication.md): the localized publishing pattern
- [Authorization](../handbook/concepts/authorization.md): server-bound identity
