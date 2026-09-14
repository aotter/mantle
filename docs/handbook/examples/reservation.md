---
description: Accept public reservation requests and expose the queue to staff, with an optional guard against past dates.
---
# Reservation requests

This example accepts reservation requests from the public and lists them for staff. It is the Builder `reservation` preset, fully declarative, plus one optional lifecycle guard. Read it if you take appointments, bookings or table requests and confirm them by hand.

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
      createdAt: { type: number, x-mcp-hint: timestamp-ms, x-mantle-bind: now }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: reservation-queue
spec:
  title: Reservation queue
  surface: staff
  from: reservations
  fields: [id, name, email, requestedFor, partySize, note, createdAt]
  orderBy:
    - { field: createdAt, direction: desc }
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

`createdAt` is stamped by the server (`x-mantle-bind: now`); a caller-supplied value is ignored. `requestedFor` is a free string on purpose: the preset does not impose a calendar model. The staff View orders by `createdAt`, so the newest request is first regardless of the requested slot.

## Worker and handlers

None are required. The Manifest above runs on the minimal Worker:

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export default createMantleWorker({ plan });
```

### Optional: reject requests for the past

If `requestedFor` is expected to be an ISO date-time, a `before_create` lifecycle Trigger can reject values that already passed. Add two documents to the Manifest:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: reject-past-reservation
spec:
  input:
    type: object
    properties:
      requestedFor: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: reject-past-reservation }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: reservations-before-create-guard
spec:
  source:
    kind: lifecycle
    schema: reservations
    on: [before_create]
    errorPolicy: abort
  target: { procedure: reject-past-reservation }
```

And one handler. `before_*` hooks receive the caller's original input; a thrown `InvokeFailure` cancels the write and its diagnostic is returned to the caller unchanged:

```ts
// src/handlers.ts
import { InvokeFailure } from "@aotter/mantle/runtime";
import { runtimeDiagnostic } from "@aotter/mantle/spec";

export async function rejectPastReservation(
  input: { readonly requestedFor?: string },
): Promise<{ ok: true }> {
  const at = input.requestedFor ? Date.parse(input.requestedFor) : Number.NaN;
  if (Number.isFinite(at) && at < Date.now()) {
    throw new InvokeFailure(
      runtimeDiagnostic({
        code: "LIFECYCLE_HOOK_REJECTED",
        severity: "error",
        path: "/requestedFor",
        value: input.requestedFor,
        expected: "a date and time that has not passed",
        message: "Reservations cannot be requested for a past time.",
      }),
    );
  }
  return { ok: true };
}
```

```ts
// src/index.ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan, type MantleHandlers } from "../.mantle/generated/mantle.js";
import { rejectPastReservation } from "./handlers.js";

const handlers = {
  "reject-past-reservation": rejectPastReservation,
} satisfies MantleHandlers;

export default createMantleWorker({ plan, extend: () => ({ handlers }) });
```

Unparseable strings pass through so free-form slots such as `Friday evening` still work. Tighten the input schema with `format: date-time` if only timestamps are acceptable. `LIFECYCLE_HOOK_REJECTED` maps to HTTP 409; the hook may throw any catalogued code, for example `INPUT_VALIDATION_FAILED` for 400. See [Writes: Procedures, Triggers and hooks](../concepts/procedures-and-triggers.md).

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
    "data": { "name": "Ada", "email": "ada@example.test", "requestedFor": "2026-10-03T19:00:00+08:00", "partySize": 4, "createdAt": 1788879363492 },
    "authorId": null,
    "createdAt": 1788879363492,
    "updatedAt": 1788879363492
  }
}
```

A `partySize` of `0` is HTTP 400 `INPUT_VALIDATION_FAILED`. With the optional guard installed, a `requestedFor` in the past is HTTP 409 with `diagnostic.code: "LIFECYCLE_HOOK_REJECTED"` and no row is written.

Staff list the queue at `GET /admin/api/views/reservation-queue?page=1&show=50` (staff session required); `GET /admin/api/views/reservation-queue/export` returns the matching rows as CSV.

MCP tools:

| Surface | Tool | Origin |
|---|---|---|
| `/mcp` | `submit_reservation` | `submit-reservation-mcp` Trigger |
| `/mcp/staff` | `query_view_reservation_queue` | `reservation-queue` View |
| `/mcp/staff` | `create_record_reservations`, `update_record_reservations` | operational Schema `reservations` |

Mantle Builder ships this Manifest as its Reservation preset.

## What this deliberately leaves out

Requests are **not confirmed automatically**. A successful `POST` means the request was recorded, nothing more. The pattern omits:

- **Slot inventory.** There is no `slots` Schema and no capacity count.
- **Double-booking prevention.** Two requests for the same time both succeed. Preventing that needs an authority that serializes reservations, as the [commerce example](./commerce-transaction.md) does for stock with a Durable Object.
- **Calendar sync, payments, deposits.**
- **Confirmation messages.** Add an `after_create` handler as in the [intake form](./intake-form.md) when staff want a notification.

## Source

- [`README.md`](../../../README.md) — reservations excerpt
- [`docs/design-atoms.md`](../../../docs/design-atoms.md) — builtin `create`, lifecycle hooks
- [`packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts) — `InvokeFailure`
- [`packages/mantle-runtime/src/index.ts`](../../../packages/mantle-runtime/src/index.ts) — `InvokeFailure` export re-exported by `@aotter/mantle/runtime`
