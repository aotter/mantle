---
description: Members submit purchase requisitions and see only their own; staff review the queue with an optimistic lock.
---
# Procurement approvals with member and staff roles

[Examples hub](./README.md)

Two audiences share one table: signed-in members submit and track their own
requisitions, and staff approve or reject them. Every Procedure is SQL.

## Problem

A signed-in member submits a request number, an item, a quantity, a need-by
date and a justification, and sees only their own requisitions. Staff with the
`owner` or `editor` role see every `submitted` requisition, soonest need-by
date first, and mark each `approved` or `rejected` with a note. Two reviewers
must not silently overwrite each other's decision.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: purchase-requisitions }
spec:
  title: Purchase requisitions
  description: Member-submitted purchase needs waiting for staff review.
  lifecycle: operational
  uniqueIndexes: [[requestNumber]]
  indexes:
    - [requestedBy, needBy]
    - [requestStatus, needBy]
  schema:
    type: object
    additionalProperties: false
    readOnly: true
    required: [requestNumber, requestedBy, item, quantity, needBy, justification, requestStatus]
    properties:
      requestNumber: { type: string, maxLength: 40, pattern: "^REQ-[A-Z0-9-]+$" }
      requestedBy: { type: string }
      item: { type: string, minLength: 1, maxLength: 160 }
      quantity: { type: integer, minimum: 1 }
      needBy: { type: string, format: date }
      justification: { type: string, minLength: 1, maxLength: 1000 }
      requestStatus: { type: string, enum: [submitted, approved, rejected] }
      reviewerNote: { type: string, maxLength: 1000 }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: my-requisitions }
spec:
  title: My requisitions
  description: The signed-in member's own purchase requisitions and their approval status.
  surface: public
  requires: { auth: { all: [ctx.user] } }
  sql: |
    SELECT id, requestNumber, item, quantity, needBy, justification, requestStatus, reviewerNote, created_at
    FROM "purchase-requisitions"
    WHERE requestedBy = auth.uid()
    ORDER BY created_at DESC LIMIT 100
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: pending-approvals }
spec:
  title: Pending approvals
  description: Purchase requisitions waiting for a staff decision, soonest need-by date first.
  surface: staff
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  sql: |
    SELECT id, version, requestNumber, requestedBy, item, quantity, needBy, justification, created_at
    FROM "purchase-requisitions"
    WHERE requestStatus = 'submitted'
    ORDER BY needBy LIMIT 100
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: submit-requisition }
spec:
  title: Submit requisition
  description: Submit a purchase requisition as the signed-in member.
  requires: { auth: { all: [ctx.user] } }
  input:
    type: object
    additionalProperties: false
    required: [requestNumber, item, quantity, needBy, justification]
    properties:
      requestNumber: { type: string, maxLength: 40, pattern: "^REQ-[A-Z0-9-]+$" }
      item: { type: string, minLength: 1, maxLength: 160 }
      quantity: { type: integer, minimum: 1 }
      needBy: { type: string, format: date }
      justification: { type: string, minLength: 1, maxLength: 1000 }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO "purchase-requisitions" (requestNumber, requestedBy, item, quantity, needBy, justification, requestStatus)
      VALUES (input.requestNumber, auth.uid(), input.item, input.quantity, input.needBy, input.justification, 'submitted')
      RETURNING id, requestNumber AS "requestNumber"
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: review-requisition }
spec:
  title: Review requisition
  description: Approve or reject a submitted requisition, with the version the reviewer saw.
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  input:
    type: object
    additionalProperties: false
    required: [id, expectedVersion, requestStatus]
    properties:
      id:
        type: string
        x-mantle-ref: { schema: purchase-requisitions, field: id }
      expectedVersion: { type: integer, minimum: 1 }
      requestStatus: { type: string, enum: [approved, rejected] }
      reviewerNote: { type: string, maxLength: 1000 }
  output: { type: object }
  handler:
    sql: |
      UPDATE "purchase-requisitions"
      SET requestStatus = input.requestStatus, reviewerNote = COALESCE(input.reviewerNote, reviewerNote)
      WHERE id = input.id AND version = input.expectedVersion AND requestStatus = 'submitted'
      RETURNING id, version, requestStatus AS "requestStatus"
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submit-requisition-http }
spec:
  source: { kind: http, method: POST, path: /api/requisitions }
  target: { procedure: submit-requisition }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submit-requisition-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: submit-requisition }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: review-requisition-mcp }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: review-requisition }
```

### Ownership without trusting the caller

- **The writer is `auth.uid()`, never an input.** `submit-requisition` sets
  `requestedBy` to the caller's subject key in its SQL, and its input has no
  such field. The status starts as the literal `'submitted'`.
- **Why not `scope`?** `scope: { requestedBy: auth.uid() }` would hide every
  other member's rows from *every* user caller, staff included, so reviewers
  could not see the queue. Scope is for rows only their owner may ever see.
  Here the member View filters on `requestedBy = auth.uid()` instead, and
  `requires: ctx.user` means an anonymous caller is 401 before the query runs.
- **Generic Admin access is a separate entrance.** The View's SQL filter and
  `requires` protect that View, not generic Schema entry routes. Root
  `schema.readOnly: true` blocks generic Admin create, patch and delete, so
  every write goes through the declared Procedures. It does not block reads:
  Admin admits contributors by default, and this Schema is not scoped. If
  only owner/editor reviewers may read everyone's requisitions, restrict the
  Admin surface in the application; see [Roles](../handbook/guides/admin-ui.md#roles).
  Keep that restriction inside the existing `withCaller` boundary. Members
  and contributors use the owner-filtered public View instead.
- **A Schema whose name is not a plain identifier is quoted in SQL**:
  `"purchase-requisitions"`.

### Optimistic concurrency

`review-requisition` pins one row with `id = input.id AND version =
input.expectedVersion`. `expectedVersion` is the version the reviewer read,
not that value plus one. A stale version matches no row, and a row op that
writes nothing fails with `CONFLICT` (HTTP 409), so nothing changes and the
reviewer reads again. `requestStatus = 'submitted'` in the same `WHERE` keeps a
decided row from being decided twice. The Procedure's `target` is inferred from
that `WHERE`.

The object form of `x-mantle-ref` names the bound field. The Schema's one
single-field unique index is `[requestNumber]`, so the string form would leave
Admin to guess, and it would pick the request number.

## Handlers

None.

## Try it

```sh
curl -i http://127.0.0.1:8787/api/views/my-requisitions
# HTTP 401, {"error":{"code":"UNAUTHENTICATED",...}}

curl -sS -X POST http://127.0.0.1:8787/api/requisitions \
  -H 'content-type: application/json' -H "origin: http://127.0.0.1:8787" -H "cookie: $SESSION_COOKIE" \
  -d '{"requestNumber":"REQ-2026-0002","item":"Monitor arm","quantity":2,"needBy":"2026-11-02","justification":"Second screen for review work."}'
```

A duplicate `requestNumber` is HTTP 409 `CONFLICT`. Staff call
`pending_approvals` on `/mcp/staff`, then:

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "review_requisition", "arguments": { "id": "<id>", "expectedVersion": 1, "requestStatus": "approved", "reviewerNote": "Within budget." } }
}
```

Replaying `expectedVersion: 1` afterwards is an error result with code
`CONFLICT`. A contributor gets `AUTH_DENIED`. The public surface lists
`submit_requisition` and `my_requisitions`; `review_requisition` is only on the
staff surface.

## What this leaves out

- **Approval chains.** One decision by one staff member. Sequential approvers
  need a step field and SQL conditions on the current step and caller. Use a
  hook or guard only for a check SQL cannot express.
- **Budgets.** A live budget check belongs in a `requires.guard` handler.
- **Notifications.** See the `after_create` hook in
  [Intake with bot check and notification](./intake-hooks.md).

## Source

- [Authorization](../handbook/concepts/authorization.md): `scope`, `auth.uid()` and `requires`
- [Procedure reference](../handbook/reference/procedure.md): row ops and locks
