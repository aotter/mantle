---
description: Accept public reservation requests and expose the queue to staff. One SQL INSERT, no handler code.
---
# Reservation requests

[Examples hub](./README.md)

Visitors ask for a reservation and staff confirm by hand. The manifests are
fully declarative: the one Procedure is a SQL `INSERT`. Use this for
appointments, bookings or table requests where a person decides.

## Problem

A visitor gives a name, an email address, the requested slot, an optional party
size and a note. Staff see the newest requests first through Admin's API or the
staff MCP surface, and follow up outside the system. Requests are records, so
the Schema is `operational`. The system does not decide whether a slot is free.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: reservations }
spec:
  title: Reservations
  lifecycle: operational
  checks: ["partySize IS NULL OR partySize BETWEEN 1 AND 20"]
  schema:
    type: object
    additionalProperties: false
    required: [name, email, requestedFor]
    properties:
      name: { type: string, minLength: 1, maxLength: 120 }
      email: { type: string, format: email }
      requestedFor: { type: string, description: Requested date, time or slot. }
      partySize: { type: integer, minimum: 1 }
      note: { type: string, maxLength: 1000 }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: reservation-queue }
spec:
  title: Reservation queue
  surface: staff
  requires: { auth: { all: [{ ctx.staff: [owner, editor, contributor] }] } }
  sql: |
    SELECT id, name, email, requestedFor, partySize, note, created_at
    FROM reservations
    ORDER BY created_at DESC LIMIT 50
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: submit-reservation }
spec:
  title: Submit reservation
  description: Ask for a reservation; staff confirm it by hand.
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
  handler:
    sql: |
      INSERT INTO reservations (name, email, requestedFor, partySize, note)
      VALUES (input.name, input.email, input.requestedFor, input.partySize, input.note)
      RETURNING id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submit-reservation-http }
spec:
  source: { kind: http, method: POST, path: /api/reservations }
  target: { procedure: submit-reservation }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submit-reservation-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: submit-reservation }
```

- `requestedFor` is a free string on purpose: the example imposes no calendar
  model. The queue orders by the native `created_at`, so the newest request is
  first whatever slot it asks for.
- An optional input that the caller leaves out binds as `NULL`.
- `checks` are boolean SQL over the row's own columns, enforced on every insert
  and update, Admin's included. The input schema already refuses `partySize: 0`;
  the check also caps the party for writes that do not come through this
  Procedure.

## Handlers

None.

## Try it

```sh
curl -sS -X POST http://127.0.0.1:8787/api/reservations \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.test","requestedFor":"2026-10-03T19:00:00+08:00","partySize":4}'
```

The answer is `{ "results": [[{ "id": "…" }]] }`. A `partySize` of `0` is
HTTP 400 `INPUT_VALIDATION_FAILED`; `25` fails the check, also with a 400.

Staff list the queue at `GET /admin/api/views/reservation-queue?limit=50` with
a staff session. `GET /admin/api/views/reservation-queue/export` returns the
rows as CSV.

| MCP surface | Tool | From |
|---|---|---|
| `/mcp` | `submit_reservation` | the `submit-reservation-mcp` Trigger |
| `/mcp/staff` | `reservation_queue` | the staff View |

## What this leaves out

A successful `POST` records the request, nothing more.

- **Slot inventory and double booking.** Two requests for one time both
  succeed. With a `slots` Schema, a capacity column and `checks: ["booked <=
  capacity"]`, a two-statement Procedure (insert the reservation, then
  `UPDATE slots SET booked = booked + 1 WHERE id = input.slotId`) refuses the
  overbooking atomically, as [Commerce inventory](./commerce-inventory.md) does
  for stock.
- **Past dates.** Reject them in a `requires.guard` handler, as
  [Intake with bot check and notification](./intake-hooks.md) does for its
  token.
- **Calendar sync, payments and confirmation emails.** An `after_create` hook
  as in the intake example.

## Source

- [Procedure reference](../handbook/reference/procedure.md)
- [Schema reference](../handbook/reference/schema.md): `checks`
