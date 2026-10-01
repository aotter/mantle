---
description: A public intake form that inserts operational request rows with one SQL statement. No bot check or email hooks.
---
# Intake form

[Examples hub](./README.md) · Bot checks and staff email are [Intake with bot check and notification](./intake-hooks.md).

Anonymous visitors submit a request, and staff list recent submissions. The
only Procedure is one SQL `INSERT`; there is no handler code. Use this shape for
any form that anonymous visitors submit.

## Problem

Visitors send a name, an email address and a message. Staff read recent
submissions through Admin's API or the staff MCP surface. Submissions are
records, not authored content, so the Schema is `operational`: a row is live as
soon as it is written.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: requests }
spec:
  title: Requests
  description: Requests submitted through the public intake form.
  lifecycle: operational
  schema:
    type: object
    additionalProperties: false
    required: [name, email, message]
    properties:
      name: { type: string, minLength: 1, maxLength: 120 }
      email: { type: string, format: email }
      message: { type: string, minLength: 1, maxLength: 2000 }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: recent-requests }
spec:
  title: Recent requests
  surface: staff
  requires: { auth: { all: [{ ctx.staff: [owner, editor, contributor] }] } }
  sql: |
    SELECT id, name, email, message, created_at FROM requests
    ORDER BY created_at DESC LIMIT 50
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: submit-request }
spec:
  title: Submit request
  description: Create a new public request.
  input:
    type: object
    additionalProperties: false
    required: [name, email, message]
    properties:
      name: { type: string, minLength: 1, maxLength: 120 }
      email: { type: string, format: email }
      message: { type: string, minLength: 1, maxLength: 2000 }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO requests (name, email, message)
      VALUES (input.name, input.email, input.message)
      RETURNING id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submit-request-http }
spec:
  source: { kind: http, method: POST, path: /api/requests }
  target: { procedure: submit-request }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submit-request-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: submit-request }
```

The submission time is the native `created_at` column, which Store fills; a
write can never set it. A column the SQL does not name keeps its default, so a
caller cannot add fields: the `INSERT` lists exactly what is stored.

## Handlers

None. The plan has no `ref`, so the generated `src/handlers.ts` is an empty map.

## Try it

```sh
curl -sS -X POST http://127.0.0.1:8787/api/requests \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.test","message":"Please call me back."}'
```

An inline SQL Procedure answers `{ "results": [...] }`, one array of
`RETURNING` rows per statement, here `[[{ "id": "…" }]]`. A missing `name` is
HTTP 400 `INPUT_VALIDATION_FAILED`.

Staff read the queue at `GET /admin/api/views/recent-requests?limit=50` with a
staff session; the response is `{ rows, nextCursor? }`.

| MCP surface | Tool | From |
|---|---|---|
| `/mcp` | `submit_request` | the `submit-request-mcp` Trigger |
| `/admin/api/mcp` | `recent_requests` | the staff View |

A Schema is never an MCP tool. Staff edit rows in Admin's API
(`/admin/api/entries`), not through generated record tools.

## What this leaves out

- **Bot check and notification.** They are `ref` lifecycle hooks in
  [Intake with bot check and notification](./intake-hooks.md).
- **Deduplication.** Two identical submissions are two rows.
- **Rate limiting.** Put a per-form quota in the service's own `fetch`, in
  front of the REST surface.

## Source

- [Procedure reference](../handbook/reference/procedure.md)
- [View reference](../handbook/reference/view.md)
