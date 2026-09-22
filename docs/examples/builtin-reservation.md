---
description: Accept public reservation requests and expose the queue to staff. Every Procedure is builtin create.
---
# Reservation requests

**Handler class:** builtin · **Builder:** yes · [Examples hub](./README.md).

This example accepts reservation requests from the public and lists them for staff. The published Manifest is fully declarative: every Procedure is `handler.kind: builtin`. Read it if you take appointments, bookings or table requests and confirm them by hand. A `before_create` date guard is application code; see [Intake Turnstile and email hooks](./cf-primitives-intake-hooks.md) for that `ref` pattern.

## Problem

A visitor asks for a reservation by giving a name, an email address, the requested date or slot, an optional party size and a note. Staff see the newest requests first in Admin, over the staff View REST route, or through Staff MCP, and follow up outside the system. Requests are live operational records; nothing is drafted or published. The system does not decide whether a slot is free.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: reservations
spec:
  title: Reservations
  lifecycle: operational
  schema:
    type: object
    additionalProperties: false
    required: [name, email, requestedFor]
    properties:
      name: { type: string, minLength: 1, maxLength: 120 }
      email: { type: string, format: email }
      requestedFor: { type: string, description: Requested date, time, or slot. }
      partySize: { type: integer, minimum: 1 }
      note: { type: string, maxLength: 1000 }
      submittedAt: { type: number, x-mcp-hint: timestamp-ms, x-mantle-bind: now }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: reservation-queue
spec:
  title: Reservation queue
  surface: staff
  from: reservations
  fields: [id, name, email, requestedFor, partySize, note, submittedAt]
  orderBy:
    - { field: submittedAt, direction: desc }
  limit: 50
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: submit-reservation
spec:
  title: Submit reservation
  input:
    type: object
    additionalProperties: false
    required: [name, email, requestedFor]
    properties:
      name: { type: string, minLength: 1, maxLength: 120 }
      email: { type: string, format: email }
      requestedFor: { type: string }
      partySize: { type: integer, minimum: 1 }
      note: { type: string, maxLength: 1000 }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: reservations }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: submit-reservation-http
spec:
  source: { kind: http, method: POST, path: /api/reservations }
  target: { procedure: submit-reservation }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: submit-reservation-mcp
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: submit-reservation }
```

`submittedAt` is stamped by the server (`x-mantle-bind: now`); a caller-supplied value is ignored. `requestedFor` is a free string on purpose: this example does not impose a calendar model. The staff View orders by `submittedAt`, so the newest request is first regardless of the requested slot.

## Worker and handlers

None are required. The Manifest above runs on the minimal Worker:

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export default createMantleWorker({ plan });
```

A `before_create` guard that rejects ISO dates already in the past is a `handler.kind: ref` Procedure. It is not part of this Manifest. The abort-hook shape, `InvokeFailure`, and `LIFECYCLE_HOOK_REJECTED` (HTTP 409) are in [Intake Turnstile and email hooks](./cf-primitives-intake-hooks.md) and [Writes: Procedures, Triggers and hooks](../handbook/concepts/procedures-and-triggers.md).

## Try it

```sh
curl -sS -X POST http://localhost:8787/api/reservations \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.test","requestedFor":"2026-10-03T19:00:00+08:00","partySize":4}'
```

```json
{
  "ok": true,
  "data": {
    "id": "res_01j...",
    "collection": "reservations",
    "status": "published",
    "version": 1,
    "data": { "name": "Ada", "email": "ada@example.test", "requestedFor": "2026-10-03T19:00:00+08:00", "partySize": 4, "submittedAt": 1788879363492 },
    "authorId": null,
    "createdAt": 1788879363492,
    "updatedAt": 1788879363492
  }
}
```

A `partySize` of `0` is HTTP 400 `INPUT_VALIDATION_FAILED`.

Staff list the queue at `GET /admin/api/views/reservation-queue?page=1&show=50` (staff session required); `GET /admin/api/views/reservation-queue/export` returns the matching rows as CSV.

MCP tools:

| Surface | Tool | Origin |
|---|---|---|
| `/mcp` | `submit_reservation` | `submit-reservation-mcp` Trigger |
| `/mcp/staff` | `query_view_reservation_queue` | `reservation-queue` View |
| `/mcp/staff` | `create_record_reservations`, `update_record_reservations` | operational Schema `reservations` |

## What this deliberately leaves out

Requests are **not confirmed automatically**. A successful `POST` means the request was recorded, nothing more. The pattern omits:

- **Slot inventory.** There is no `slots` Schema and no capacity count.
- **Double-booking prevention.** Two requests for the same time both succeed. Preventing that needs an authority that serializes reservations, as the [commerce example](./cf-primitives-commerce-inventory.md) does for stock with a Durable Object.
- **Calendar sync, payments, deposits.**
- **Confirmation messages.** Add an `after_create` handler as in the [intake form](./cf-primitives-intake-hooks.md) when staff want a notification.

## Source

- [`README.md`](../../README.md) — reservations excerpt
- [Procedure reference](../handbook/reference/procedure.md) — builtin `create`
- [Intake Turnstile and email hooks](./cf-primitives-intake-hooks.md) — optional `before_create` `ref` guard
