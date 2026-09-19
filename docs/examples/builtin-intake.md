---
description: A public intake form that creates operational request rows with a builtin handler. No Turnstile or email ref hooks.
---
# Intake form

**Handler class:** builtin · **Builder:** yes · [Examples hub](./README.md). Turnstile verification and staff email are [Intake Turnstile and email hooks](./cf-primitives-intake-hooks.md).

This example collects a public request and lists recent rows for staff. Every Procedure is `handler.kind: builtin`. Read it if you need any form that anonymous visitors submit and you are not wiring bot checks or mailers into the Manifest.

## Problem

Visitors submit a name, an email address and a message. Staff read recent submissions in Admin, over the staff View REST route, or through Staff MCP. Submissions are live records, not authored content, so the Schema is `operational`.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: requests
spec:
  title: Requests
  description: Requests submitted through the public intake flow.
  lifecycle: operational
  schema:
    type: object
    additionalProperties: false
    required: [name, email, message]
    properties:
      name: { type: string, minLength: 1, maxLength: 120 }
      email: { type: string, format: email }
      message: { type: string, minLength: 1, maxLength: 2000 }
      createdAt: { type: number, x-mcp-hint: timestamp-ms, x-mantle-bind: now }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: recent-requests
spec:
  title: Recent requests
  surface: staff
  from: requests
  fields: [id, name, email, message, createdAt]
  orderBy:
    - { field: createdAt, direction: desc }
  limit: 50
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: submit-request
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
  handler: { kind: builtin, op: create, schema: requests }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: submit-request-http
spec:
  source: { kind: http, method: POST, path: /api/requests }
  target: { procedure: submit-request }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: submit-request-mcp
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: submit-request }
```

`createdAt` is stamped by the server (`x-mantle-bind: now`); a caller-supplied value is ignored. The builtin `create` projects `input ∩ Schema.properties`.

## Worker and handlers

None are required. The Manifest above runs on the minimal Worker:

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export default createMantleWorker({ plan });
```

## Try it

```sh
curl -sS -X POST http://localhost:8787/api/requests \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.test","message":"Please call me back."}'
```

```json
{
  "ok": true,
  "data": {
    "id": "req_01j...",
    "collection": "requests",
    "status": "published",
    "version": 1,
    "data": { "name": "Ada", "email": "ada@example.test", "message": "Please call me back.", "createdAt": 1788879363492 },
    "authorId": null,
    "createdAt": 1788879363492,
    "updatedAt": 1788879363492
  }
}
```

The builtin `create` returns the `EntryRow`; `status` is `published` immediately because the Schema is operational. A missing `name` is HTTP 400 `INPUT_VALIDATION_FAILED`.

Staff read the queue at `GET /admin/api/views/recent-requests?page=1&show=50` with a staff session; the envelope is `{ ok, data: { rows, page, show, hasMore } }`.

MCP tools:

| Surface | Tool | Origin |
|---|---|---|
| `/mcp` | `submit_request` | `submit-request-mcp` Trigger |
| `/mcp/staff` | `query_view_recent_requests` | `recent-requests` View |
| `/mcp/staff` | `create_record_requests`, `update_record_requests` | operational Schema `requests` |

## What this deliberately leaves out

- **Bot check and notification.** Those are `ref` lifecycle hooks in [Intake Turnstile and email hooks](./cf-primitives-intake-hooks.md). They are not in this Manifest; Builder must not ingest that page.
- **Deduplication.** Two identical submissions create two rows.
- **Rate limiting.** The adapter applies its own request limits to Auth and Admin routes, not a per-form quota.

Related: [Reservation requests](./builtin-reservation.md) uses the same builtin-create shape; [Procurement approvals](./builtin-procurement.md) adds member and staff roles.

## Source

- [Procedure reference](../handbook/reference/procedure.md) — builtin `create`
- [Intake Turnstile and email hooks](./cf-primitives-intake-hooks.md) — Turnstile and email `ref` hooks on the same Schema
