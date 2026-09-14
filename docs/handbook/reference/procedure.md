---
description: Procedure field reference — runtime order of operations, ref and builtin handlers, the builtin op contract, EntryRow responses and Admin operations.
---
# Procedure

A Procedure is a typed callable: input schema, output schema, authorization requirement, and one handler binding. It is the only atom with a code seam, and it is never exposed on its own — a [Trigger](./trigger.md) is what makes it reachable. This page is the field-level contract; the concepts are in [Procedures and Triggers](../concepts/procedures-and-triggers.md). Envelope rules are in [Manifest envelope and conventions](./manifest.md), and diagnostic codes are catalogued in [Diagnostics](./diagnostics.md).

## Fields

| Field | Type | Required | Rules |
|---|---|---|---|
| `title` | LocalizedText | no | Admin label for the staff-operations surface. Absent falls back to a Title-Cased `metadata.name`. |
| `description` | LocalizedText | no | The MCP tool description and the `description` field of `GET /admin/api/operations`. |
| `requires` | AuthorizationRequirements | no | `auth.all` predicates plus one optional `guard.procedure`. See [Authorization](./authorization.md). |
| `input` | JSON Schema | yes | Must be an object. Becomes the MCP tool `inputSchema` and the OpenAPI request body. |
| `uiSchema` | object | no | Admin-only. Accepts `collectionAction` and `fields`. Violations are `SCHEMA_UI_INVALID`. |
| `output` | JSON Schema | yes | Checked after the handler returns. Failure is `OUTPUT_VALIDATION_FAILED` (500). |
| `handler` | `ref` \| `builtin` | yes | Exactly one binding shape; see below. |

Both `input` and `output` are walked by the [JSON Schema subset](./schema.md#json-schema-subset) validator, so the same recognized and rejected keywords apply.

## Order of operations

Every invocation — HTTP Trigger, MCP tool call, lifecycle hook, Admin operation — runs the same pipeline.

| Step | Behavior | Failure |
|---|---|---|
| 1. Authorize | Evaluate every `requires.auth.all` predicate against the caller context. | `UNAUTHENTICATED` (401) when the caller carried no credential, `AUTH_DENIED` (403) when an authenticated caller falls short. |
| 2. Validate input | Compile `input` to zod and parse the request. | `INPUT_VALIDATION_FAILED` (400), pointing at the first failing property. |
| 3. Guard | Invoke `requires.guard.procedure` with the validated input and the same context. | Any guard failure denies the target. Guards fail closed. |
| 4. Dispatch | `ref`: look up the registration key and call the function. `builtin`: run the op. | See the two handler sections. |
| 5. Validate output | Parse the handler result against `output`. | `OUTPUT_VALIDATION_FAILED` (500) — this is a handler bug, not a caller error. |

The value returned to the caller is the handler's own result. Output validation checks it; it does not strip unexpected fields.

## `handler.kind: ref`

```yaml
handler:
  kind: ref
  ref: approve-purchase-order
```

`ref` is an **opaque registration key, not a path**. It never names a file, module or export. The consumer passes a matching key in the `handlers` map given to the runtime or Worker, and the key is the whole contract between manifest and code.

| Rule | Effect |
|---|---|
| `ref` is a non-empty string; only `kind` and `ref` are accepted under `handler`. | `INVALID_MANIFEST_ENVELOPE` |
| Every declared `ref` resolves to a registered handler. | `HANDLER_NOT_REGISTERED` at boot, listing the registered keys as candidates. |
| An unregistered key reached at request time. | The same `HANDLER_NOT_REGISTERED` code, mapped to 500 — defense in depth for embeddings that skipped boot validation. |
| A handler throws. | Anything other than a structured error becomes `INTERNAL_ERROR` (500) with the handler label in the message. |

To return a structured error instead, throw `InvokeFailure` carrying a diagnostic; the runtime unwraps it and returns that diagnostic with its own status. This is how a handler reports `CONFLICT`, `ENTITLEMENT_REQUIRED` or a domain-specific `INPUT_VALIDATION_FAILED` rather than a generic 500.

### `ref` example

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: approve-purchase-order
spec:
  title: { en: Approve purchase order, "zh-TW": 核准採購單 }
  description: Approve a submitted order and record the approver.
  requires:
    auth:
      all:
        - { "ctx.staff": [owner, editor] }
  input:
    type: object
    additionalProperties: false
    required: [orderId, decision]
    properties:
      orderId: { type: string, x-mantle-ref: purchase-orders }
      decision: { type: string, enum: [approve, reject] }
      note: { type: string, maxLength: 2000 }
      requestId: { type: string, x-mcp-hint: idempotency-key }
  uiSchema:
    fields:
      note: { widget: textarea }
  output:
    type: object
    required: [orderId, status]
    properties:
      orderId: { type: string }
      status: { type: string, enum: [approved, rejected] }
  handler:
    kind: ref
    ref: approve-purchase-order
```

```ts
// src/mantle/config.ts
import { approvePurchaseOrder } from "./handlers/approve-purchase-order";

export const handlers = {
  "approve-purchase-order": approvePurchaseOrder,
};
```

## `handler.kind: builtin`

A shortcut over the entry-writer chokepoint for Procedures whose body is "write a row". Reach for `ref` as soon as there is real business logic.

```yaml
handler:
  kind: builtin
  op: create | update | upsert | delete | archive
  schema: <Schema metadata.name>
  match: [<field>, ...]   # only with op: upsert
```

| Rule | Diagnostic |
|---|---|
| Only `kind`, `op`, `schema` and `match` are accepted; `ref` alongside `builtin` is rejected. | `INVALID_MANIFEST_ENVELOPE` |
| `op` is one of the five; `schema` is a non-empty string. | `INVALID_MANIFEST_ENVELOPE` |
| `match` appears only with `op: upsert`, and is a non-empty array of unique non-empty strings. | `INVALID_MANIFEST_ENVELOPE` |
| `schema` names a declared Schema. | `BUILTIN_HANDLER_SCHEMA_UNKNOWN` |
| `input` is an object schema. | `BUILTIN_HANDLER_CONTRACT_INVALID` |
| The runtime was built without the builtin dispatcher. | `HANDLER_BUILTIN_NOT_IN_V010` at request time. |

`request_publish` and `publish` are deliberately absent: they are lifecycle operations, not CRUD primitives.

### Ops

| `op` | Runtime behavior | Input contract |
|---|---|---|
| `create` | Projects `input ∩ Schema.properties` into `data`, stamps every `x-mantle-bind` property, generates an id and writes. `status` is `draft`, or `published` on a `lifecycle: operational` Schema. `authorId` is `ctx.user?.id ?? null`. Returns the created row. | `input` is an object schema. No other required properties. |
| `update` | Loads the row (`NOT_FOUND` if absent), merges the patch over the stored `data` so omitted fields and existing stamps survive, writes under optimistic concurrency against `expectedVersion`, bumps `version`. | `id` (strict `type: string`) and `expectedVersion` (strict `type: number`) declared under `properties` **and** listed in `required`. |
| `upsert` with `match` | Reads the matched fields off the validated input and looks the row up by those data values. Found: the update path, using the row's own current version. Not found: the create path. | `match` equals one declared `uniqueIndexes` tuple exactly, in order. Every matched field is a Schema property, is declared in `input.properties`, and appears in `input.required`. `input` must **not** declare `id` or `expectedVersion`. |
| `upsert` without `match` | Legacy form. Updates when `input.id` is a string that resolves to a row; otherwise creates. | If either `id` or `expectedVersion` is declared, both must be, with strict `string` and `number` types. |
| `delete` | Loads the row (`NOT_FOUND` if absent), runs the delete guard, then hard-deletes pinned to the row's status and version. Returns `{ removed }`. | `id` (strict `type: string`) declared and in `required`. |
| `archive` | Loads the row, checks the lifecycle state machine (`CONFLICT` on an illegal transition), then transitions to `archived` pinned to the version just read. | `id` (strict `type: string`) declared and in `required`. The target Schema must be `lifecycle: publishing`; an operational target is rejected. |

Every contract violation in the right-hand column is `BUILTIN_HANDLER_CONTRACT_INVALID`, reported at the offending pointer. *Strict* means a single scalar type — an array-valued `type` or `nullable: true` does not satisfy it.

All five ops write through the same chokepoint, which validates the projected `data` against the Schema, runs the [write-time locale gate](./schema.md#write-time-locale-gate) and performs a unique-index preflight before the write.

### Side-channel input fields

`input` is the contract with the *caller*, not with the Schema. It may declare fields the collection has no column for — a CAPTCHA token, an idempotency key, a routing hint. JSON Schema's default `additionalProperties: true` lets them validate, and the builtin op projects `input ∩ Schema.properties`, so they never reach `data`.

They are not lost. The pre-projection input travels to the chokepoint as `originalInput`, and synchronous `before_*` lifecycle hooks receive it as their handler input. A `before_create` hook can therefore verify a token the row never stores. See [Trigger](./trigger.md#lifecycle-source).

### Builtin `upsert` example

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: sync-inventory-level
spec:
  title: Sync inventory level
  description: Insert or update the stock level for one SKU in one warehouse.
  requires:
    auth:
      all:
        - ctx.auth
        - { "ctx.auth.scope": "inventory:write" }
  input:
    type: object
    required: [sku, warehouse, onHand]
    properties:
      sku: { type: string, minLength: 1 }
      warehouse: { type: string, minLength: 1 }
      onHand: { type: integer, minimum: 0 }
      countedAt: { type: integer, x-mcp-hint: timestamp-ms }
      requestId: { type: string, x-mcp-hint: idempotency-key }
  output:
    type: object
    required: [id, version]
    properties:
      id: { type: string }
      version: { type: number }
  handler:
    kind: builtin
    op: upsert
    schema: inventory-levels
    match: [sku, warehouse]
```

This requires `inventory-levels` to declare `uniqueIndexes: [[sku, warehouse]]` — the same fields, in the same order. `requestId` is a side-channel field: it validates, reaches `before_*` hooks, and is never written to `data`.

## The response shape

Every builtin op except `delete` returns the persisted `EntryRow`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Generated on create. |
| `collection` | string | The Schema's `metadata.name`. |
| `status` | `draft` \| `published` \| `archived` | |
| `version` | number | Optimistic-concurrency counter; bumps on every persisted update. |
| `data` | object | The projected, stamped Schema fields. |
| `authorId` | string \| null | |
| `createdAt`, `updatedAt` | number | Unix epoch milliseconds. |
| `locale` | string | Present only when the row carries `data.locale`. |

An HTTP Trigger wraps a success as `{ "ok": true, "data": <EntryRow> }` with status 200.

> **Warning**
> Declare `output` against the **row**, not the envelope. `output: { type: object, required: [id], properties: { id: { type: string } } }` checks that an id came back. Output validation does not strip the other fields, so a caller still receives the whole row; use a `ref` handler with an explicit projection when the response must be smaller.

`delete` returns `{ removed: boolean }` instead.

## Conflicts and idempotency

A unique-index preflight runs before every write, and the database's own constraints catch the races the preflight misses. Both surface as `CONFLICT` (409), as do a stale `expectedVersion` and an illegal lifecycle transition. **There is no automatic retry** — the caller decides whether to re-read and try again.

Idempotency has no grammar key. The convention is an `input` property marked `x-mcp-hint: idempotency-key`: Admin generates and hides one UUID per form submission, and other callers generate one and reuse it across retries of the same logical request. The handler is responsible for acting on it.

Deferred lifecycle hooks have a stronger guarantee to work with: delivery is at-least-once, and handlers key on `${ctx.event.id}:${ctx.event.trigger}` — stable across enqueue fallback, queue retries and replay. See [Deferred hooks on Queues](../cloudflare/deferred-hooks-queues.md).

## `uiSchema`

Admin presentation only. It never affects input validation, the MCP tool schema or the OpenAPI document. Unknown root keys are tolerated; the parser inspects the two below.

| Key | Rule |
|---|---|
| `collectionAction` | A declared Schema name. Admin offers the Procedure as an action on that collection's list page. A non-empty string that names no Schema is `SCHEMA_UI_INVALID`; a Schema that declares `collectionAction` is rejected outright. |
| `fields.<field>.widget` | Only `textarea`. `<field>` must be a top-level property of `input` with a string type. Anything else is `SCHEMA_UI_INVALID`. |

## Staff operations in Admin

Admin derives its operations surface from the manifest graph — there is no extra grammar. A Procedure is staff-operable when **either** condition holds:

1. Some Trigger targets it with `source.kind: mcp` and `source.surface: staff` — the same predicate that builds the `/mcp/staff` tool catalog.
2. Some Trigger targets it with `source.kind: http` **and** the Procedure's `requires.auth.all` includes a `ctx.staff` predicate.

| Endpoint | Behavior |
|---|---|
| `GET /admin/api/operations` | Lists the staff-operable Procedures the calling staff member may actually run. |
| `POST /admin/api/operations/:name` | Invokes one, through the same pipeline as any other caller. |

Each listed operation carries `name`, `title`, `description`, `input`, `uiSchema`, `triggers` (the distinct kinds that qualified it, so a Procedure can be both) and `rowBindings`.

`rowBindings` come from `x-mantle-ref` on the Procedure's input properties. An input property referencing a declared, non-`translates` Schema produces `{ collection, inputField, rowField }`, and Admin offers the operation from that collection's row menu with the field pre-filled and read-only. `rowField` is the target Schema's same-named property when it has one, otherwise the lone field of a single single-field unique index, otherwise the reserved `id` column. Refs to unknown collections or to translation children produce no binding and no error.

Worked end-to-end examples live in [Commerce transaction](../examples/commerce-transaction.md) and [Procurement approvals](../examples/procurement-approvals.md).

## Source

- [`packages/mantle-spec/src/domain/model/ManifestGrammar.ts`](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [`packages/mantle-spec/src/domain/service/ManifestParser.ts`](../../../packages/mantle-spec/src/domain/service/ManifestParser.ts)
- [`packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts`](../../../packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts)
- [`packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts`](../../../packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts)
- [`packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts)
- [`packages/mantle-runtime/src/usecase/procedure/InvokeBuiltinUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeBuiltinUseCase.ts)
- [`packages/mantle-runtime/src/domain/service/BuiltinProjector.ts`](../../../packages/mantle-runtime/src/domain/service/BuiltinProjector.ts)
- [`packages/mantle-runtime/src/domain/model/EntryRow.ts`](../../../packages/mantle-runtime/src/domain/model/EntryRow.ts)
- [`packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts`](../../../packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts)
- [`packages/mantle-runtime/src/domain/service/io/EntryDeleteGuard.ts`](../../../packages/mantle-runtime/src/domain/service/io/EntryDeleteGuard.ts)
- [`packages/mantle-runtime/src/domain/service/CallableCapabilityProjector.ts`](../../../packages/mantle-runtime/src/domain/service/CallableCapabilityProjector.ts)
- [`packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts`](../../../packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts)
- [`packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts`](../../../packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
- [`docs/design-atoms.md`](../../../docs/design-atoms.md)
