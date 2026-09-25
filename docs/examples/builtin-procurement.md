---
description: Members submit purchase requisitions they can only see themselves; staff review them with optimistic concurrency.
---
# Procurement approvals with member and staff roles

**Handler class:** builtin · **Builder:** yes · [Examples hub](./README.md).

This example separates two audiences: signed-in members who submit and track their own requisitions, and staff who approve or reject them. Every Procedure is `handler.kind: builtin`. Read it if you need per-user rows and a staff decision step.

## Problem

A signed-in member submits a purchase requisition: a request number, an item, a quantity, a need-by date and a justification. The member sees only their own requisitions and their current status. Staff with the `owner` or `editor` role see the queue of `submitted` requisitions ordered by need-by date and mark each `approved` or `rejected` with a note. Two reviewers must not silently overwrite each other's decision. Requisitions are live operational records.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: purchase-requisitions
spec:
  title: Purchase requisitions
  description: Member-submitted purchase needs waiting for staff review.
  lifecycle: operational
  uniqueIndexes:
    - [requestNumber]
  indexes:
    - [requestedBy, requestedAt]
    - [requestStatus, needBy]
  schema:
    type: object
    additionalProperties: false
    required: [requestNumber, requestedBy, item, quantity, needBy, justification, requestStatus, requestedAt]
    properties:
      requestNumber: { type: string, pattern: "^REQ-[A-Z0-9-]+$" }
      requestedBy: { type: string, x-mantle-bind: ctx.user }
      item: { type: string, minLength: 1, maxLength: 160 }
      quantity: { type: integer, minimum: 1 }
      needBy: { type: number, x-mcp-hint: timestamp-ms }
      justification: { type: string, minLength: 1, maxLength: 1000 }
      requestStatus: { type: string, enum: [submitted, approved, rejected] }
      reviewerNote: { type: string, maxLength: 1000 }
      requestedAt: { type: number, x-mcp-hint: timestamp-ms, x-mantle-bind: now }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: my-requisitions
spec:
  title: My requisitions
  description: The signed-in member's own purchase requisitions and their approval status.
  surface: public
  from: purchase-requisitions
  requires:
    auth:
      all: [ctx.user]
  fields: [id, requestNumber, item, quantity, needBy, justification, requestStatus, reviewerNote, requestedAt]
  filter:
    eq: { field: requestedBy, value: { "$ctx.user": id } }
  orderBy:
    - { field: requestedAt, direction: desc }
  limit: 100
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: pending-approvals
spec:
  title: Pending approvals
  description: Purchase requisitions waiting for a staff approval decision, soonest need-by date first.
  surface: staff
  from: purchase-requisitions
  requires:
    auth:
      all:
        - { "ctx.staff": [owner, editor] }
  fields: [id, version, requestNumber, requestedBy, item, quantity, needBy, justification, requestedAt]
  filter:
    eq: { field: requestStatus, value: submitted }
  orderBy:
    - { field: needBy, direction: asc }
  limit: 100
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: submit-requisition
spec:
  title: Submit requisition
  requires:
    auth:
      all: [ctx.user]
  input:
    type: object
    additionalProperties: false
    required: [requestNumber, item, quantity, needBy, justification, requestStatus]
    properties:
      requestNumber: { type: string, pattern: "^REQ-[A-Z0-9-]+$" }
      item: { type: string, minLength: 1, maxLength: 160 }
      quantity: { type: integer, minimum: 1 }
      needBy: { type: number, x-mcp-hint: timestamp-ms }
      justification: { type: string, minLength: 1, maxLength: 1000 }
      requestStatus: { type: string, enum: [submitted] }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: purchase-requisitions }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: review-requisition
spec:
  title: Review requisition
  requires:
    auth:
      all:
        - { "ctx.staff": [owner, editor] }
  input:
    type: object
    additionalProperties: false
    required: [id, expectedVersion, requestStatus]
    properties:
      id:
        type: string
        x-mantle-ref: { schema: purchase-requisitions, field: id }
      expectedVersion: { type: number, minimum: 1 }
      requestStatus: { type: string, enum: [approved, rejected] }
      reviewerNote: { type: string, maxLength: 1000 }
  output: { type: object }
  handler: { kind: builtin, op: update, schema: purchase-requisitions }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: submit-requisition-http
spec:
  source: { kind: http, method: POST, path: /api/requisitions }
  target: { procedure: submit-requisition }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: submit-requisition-mcp
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: submit-requisition }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: review-requisition-mcp
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: review-requisition }
```

### Ownership without trusting the caller

`requestedBy` carries `x-mantle-bind: ctx.user`. On create the server stamps the signed-in user's id and ignores any caller value; on update the stamp is preserved. `requestedAt` is stamped the same way with `now`. Because both are in `required`, and because `submit-requisition` requires `ctx.user`, an anonymous caller is rejected with `UNAUTHENTICATED` before the row is even projected.

`my-requisitions` filters with the closed sentinel `{ "$ctx.user": id }`. The caller never supplies this value, so the same View is safe over REST and public MCP. Three rules make the sentinel legal, and the parser enforces each:

| Rule | Diagnostic when violated |
|---|---|
| The View's `requires.auth.all` includes `ctx.user` | `VIEW_FILTER_CTX_USER_REF_REQUIRES_AUTH` |
| The sentinel appears only under `eq`, as a single-key object whose value is the literal `id` | `VIEW_FILTER_CTX_USER_REF_INVALID` |
| The filtered field is the leftmost field of a declared index (`[requestedBy, requestedAt]` here) | `VIEW_FILTER_CTX_USER_REF_REQUIRES_INDEX` |

A missing identity fails with 401; the runtime never drops the filter and never falls back to all rows.

`pending-approvals` uses the staff predicate `{ "ctx.staff": [owner, editor] }`. It includes `version` in `fields` so a reviewer can pass it back as `expectedVersion`.

### Optimistic concurrency

`review-requisition` is a builtin `update`. Its input must declare `id` (string) and `expectedVersion` (number) in `required`; the parser rejects the Manifest otherwise. `expectedVersion` is the version the reviewer **read**, not that value plus one. At runtime the row is loaded, the patch is merged over existing data (omitted fields and server stamps survive), and the write is applied only if the stored version equals `expectedVersion`. A stale version fails with `CONFLICT` (HTTP 409) and nothing changes; the reviewer re-reads and decides again. Admin binds and hides `expectedVersion` on row-bound forms. `requestStatus` is narrowed to `approved | rejected`, so this Procedure cannot move a row back to `submitted`.

### Review operation

`pending-approvals` exposes the entry `id` and `version` required by `review-requisition`. Drive reviews from that View through Staff MCP or `POST /admin/api/operations/review-requisition`.

The Procedure marks `id` with the object form `x-mantle-ref: { schema: purchase-requisitions, field: id }`. The explicit `field` matters here. This Schema's lone single-field unique index is `[requestNumber]`, and the string form would leave Admin to infer the bound field, which would pick the request number. Builtin `update` needs the entry id, so the row action in `pending-approvals` now pre-fills exactly that. `field` may name `id` or a single-field unique index; anything else is `MANTLE_REF_INVALID`.

See [Authorization](../handbook/concepts/authorization.md) and the [Procedure reference](../handbook/reference/procedure.md).

## Worker and handlers

None. Both Procedures are builtin and the Worker is `export default createMantleWorker({ plan })`; add `mcpApps` to render the Views in chat, as in [In chat, with the MCP App](#in-chat-with-the-mcp-app). Sign-in is provided by the conventional Worker's Auth; see [Authentication](../handbook/cloudflare/authentication.md).

## Try it

Anonymous read of the member View:

```sh
curl -i http://localhost:8787/api/views/my-requisitions
```

```txt
HTTP/1.1 401 Unauthorized
{"ok":false,"diagnostic":{"code":"UNAUTHENTICATED","phase":"runtime","severity":"error","path":"...#/requires/auth/all/0", ...}}
```

Signed in (session cookie), the same request returns only rows whose `requestedBy` equals the caller's id:

```sh
curl -sS http://localhost:8787/api/views/my-requisitions \
  -H "cookie: $SESSION_COOKIE"
# {"ok":true,"data":{"rows":[{"id":"pr_01j...","requestNumber":"REQ-2026-0001","item":"Standing desk","quantity":1,"needBy":1791475200000,"justification":"...","requestStatus":"submitted","requestedAt":1788879363492}],"page":1,"show":100,"hasMore":false}}
```

Submit as a member (mutations authenticated by a session cookie also pass a same-origin check):

```sh
curl -sS -X POST http://localhost:8787/api/requisitions \
  -H 'content-type: application/json' -H "cookie: $SESSION_COOKIE" \
  -d '{"requestNumber":"REQ-2026-0002","item":"Monitor arm","quantity":2,"needBy":1791475200000,"justification":"Second screen for review work.","requestStatus":"submitted"}'
```

The response is `{ ok: true, data: <EntryRow> }`; `data.requestedBy` is the caller's id even if the body tried to set it. A duplicate `requestNumber` is HTTP 409 `CONFLICT`.

Staff review through Staff MCP on `/mcp/staff`. First `query_view_pending_approvals` returns `id` and `version`; then:

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "review_requisition",
    "arguments": { "id": "pr_01j...", "expectedVersion": 1, "requestStatus": "approved", "reviewerNote": "Within budget." }
  }
}
```

A second reviewer replaying `expectedVersion: 1` after that succeeds receives an `isError` result whose `diagnostics[0].code` is `CONFLICT`. A contributor-role session is denied with `AUTH_DENIED`. `review_requisition` appears only in `tools/list` on `/mcp/staff`; the public surface lists `submit_requisition` and `query_view_my_requisitions`.

## In chat, with the MCP App

Register the built-in interaction App on both surfaces, as in [MCP and agents](../handbook/concepts/mcp-and-agents.md#the-built-in-interaction-app):

```ts
import { interactionAppResource } from "@aotter/mantle-ui/mcp-app";

export default createMantleWorker({
  plan,
  mcpApps: {
    public: { resources: [interactionAppResource()] },
    staff: { resources: [interactionAppResource()] },
  },
});
```

The two audiences then work in chat:

- **Members** see `query_view_my_requisitions` rendered as rows. That View has no row actions, so the App only lists. A new request is a plain `submit_requisition` call; the App does not render a form for it.
- **Reviewers** ask what is waiting. The agent calls `query_view_pending_approvals`, and the App lists the requisitions. `review_requisition` opens against the chosen row, with `id` and `expectedVersion` bound, so the reviewer only picks a decision and a note. The App reads the requisition with `read_entry` first.
  - If someone else decided first, the App shows what changed and asks for a review before anything is sent.
  - A stale `expectedVersion` still fails with `CONFLICT`, and the note is kept.

Clients without MCP Apps run the same steps with the plain tools.

## What this deliberately leaves out

- **Multi-step approval chains.** One decision by one staff member. Sequential approvers would add a step field, more enum states and a `before_update` hook that validates the transition.
- **Budgets.** No cost field and no per-department limit; add a `ref` guard Procedure when a live check is needed.
- **Notifications.** Neither the submitter nor the reviewer is emailed. The [intake form](./cf-primitives-intake-hooks.md) shows the `after_create` pattern.

Related: [Guarded API access](./cf-primitives-guarded-api.md) covers credentials and scopes for non-browser callers.

## Source

- [Procedure reference](../handbook/reference/procedure.md) — `x-mantle-bind`, `x-mantle-ref`, builtin `update` contract, RBAC
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../packages/mantle-admin/src/mountMantleAdmin.ts) — `discoverRowBindings` and `rowField` derivation
- [`packages/mantle-runtime/src/domain/service/AuthPredicateEvaluator.ts`](../../packages/mantle-runtime/src/domain/service/AuthPredicateEvaluator.ts) — `UNAUTHENTICATED` versus `AUTH_DENIED`
