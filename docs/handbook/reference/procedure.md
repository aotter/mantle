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
| `target` | `{ schema, id, version? }` | no | The entity a `ref` handler mutates and whose version it locks. `schema` is an existing Schema, `id` a required string input property, `version` a number input property. Declare it only when an interaction must bind to one entry, for example a row action or automatic version binding. Queries, notifications and multi-entry Procedures declare none. Rejected on builtin handlers, whose target is `handler.schema`. Violations are `PROCEDURE_TARGET_INVALID`. |
| `mcp` | object | no | MCP tool annotations the author asserts: `readOnlyHint`, `destructiveHint`, `openWorldHint` (booleans). Core infers what it can prove — every builtin handler writes, `op: delete` destroys, an `x-mcp-hint: idempotency-key` input makes the tool idempotent — and emits nothing else, so absent hints keep the MCP spec's conservative defaults. `readOnlyHint: true` on a builtin handler is `BUILTIN_HANDLER_CONTRACT_INVALID`. |

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
| A handler throws. | Anything other than a structured error becomes `INTERNAL_ERROR` (500) with a safe generic message; exception details remain in internal logs. |

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
| `update` | Loads the row (`NOT_FOUND` if absent), merges the patch over the stored `data` so omitted fields and existing stamps survive, writes under optimistic concurrency against the caller's `expectedVersion` (observed native `entry.version` at read time, not `version+1`), bumps `version`. | `id` (strict `type: string`) and `expectedVersion` (strict `type: number`) declared under `properties` **and** listed in `required`. |
| `upsert` with `match` | Reads the matched fields off the validated input and looks the row up by those data values. Found: the update path, using the **caller's** `expectedVersion` (never the preloaded row's version). Not found: the create path only when `expectedVersion` is omitted; a versioned write for a missing row is `NOT_FOUND` and does not recreate. | `match` equals one declared `uniqueIndexes` tuple exactly, in order. Every matched field is a Schema property, is declared in `input.properties`, and appears in `input.required`. `input` must **not** declare `id`. `expectedVersion` **must** be declared as strict `number`; it is not globally required so create can omit it. |
| `upsert` without `match` | Id-based upsert. Create when the caller omits `expectedVersion` (and either omits `id` or the id is unknown). Update when a resolved `id` is present — the caller token is required and is the OCC check. A versioned write for a missing id is `NOT_FOUND`. | `expectedVersion` must be declared as strict `number`. If `id` is declared it must be strict `string`. Neither is in `required`. |
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
      expectedVersion: { type: number }
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

This requires `inventory-levels` to declare `uniqueIndexes: [[sku, warehouse]]` — the same fields, in the same order. `requestId` is a side-channel field: it validates, reaches `before_*` hooks, and is never written to `data`. `expectedVersion` is the observed native `entry.version` at read time (not `version+1`). Omit it to create; send it to update. A matched upsert has no single operation target, so Admin shows `expectedVersion` as an ordinary input there; it binds and hides it only for an id-based upsert (ADR-0029). HTTP and MCP callers supply it themselves.

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

A unique-index preflight runs before individual writes, and the database's own constraints catch the races the preflight misses. Atomic groups rely on the transaction's database constraints so an earlier operation may free a unique value for a later one. Both paths surface collisions as `CONFLICT` (409), as do a stale `expectedVersion` and an illegal lifecycle transition. **There is no automatic retry** — the caller decides whether to re-read and try again.

Idempotency has no grammar key. The convention is an `input` property marked `x-mcp-hint: idempotency-key`: Admin generates and hides one UUID per form submission, and other callers generate one and reuse it across retries of the same logical request. The handler is responsible for acting on it.

Optimistic concurrency uses the reserved input name `expectedVersion` — the version the caller **read**, not the next version. First-party Admin and the MCP App bind and hide it from the row the person reviewed, where the operation target declares it (builtin `update` and id-based `upsert`, or `Procedure.spec.target.version`); other callers send it themselves. There is no `x-mcp-hint` for OCC. On `CONFLICT` (409) Admin keeps the operator's business fields and requires an explicit re-read and review; it does not retry with the latest version. New reserved Procedure input names need an ADR.

Deferred lifecycle hooks have a stronger guarantee to work with: delivery is at-least-once, and handlers key on `${ctx.event.id}:${ctx.event.trigger}` — stable across enqueue fallback, queue retries and replay. See [Deferred hooks on Queues](../cloudflare/deferred-hooks-queues.md).

## Atomic entry writes in a ref handler

When one request must change several Schemas together, a `ref` handler can call
`ctx.writeAtomically(operations)`. Cloudflare D1 and Bun SQLite support it; an
adapter without the optional `atomicEntries` capability returns
`RESOURCE_UNAVAILABLE` (503)
instead of committing part of the group. Operations use the `createDraft`,
`updateDraft`, or `deleteEntry` request shape; atomic deletes additionally
require `expectedVersion`. Operational Schemas become live on create;
publishing Schemas create drafts. Updates and deletes require the version the
caller read.

```ts
const sessionId = crypto.randomUUID();
const rows = await ctx.writeAtomically!([
  { kind: "create", id: sessionId, request: {
    collection: "sessions", data: { name: input.name }, authorId: ctx.user?.id ?? null, ctx,
  } },
  { kind: "create", request: {
    collection: "exercise-blocks", data: { sessionId, exercise: input.exercise },
    authorId: ctx.user?.id ?? null, ctx,
  } },
  { kind: "create", request: {
    collection: "receipts", data: { token: input.requestId }, authorId: ctx.user?.id ?? null, ctx,
  } },
]);
return { sessionId: rows[0]!.id };
```

Declare `receipts.token` as a Schema `uniqueIndexes: [[token]]`. A duplicate
receipt rejects the whole group, including the session and block. The handler
can then read the existing receipt **after** the failed transaction to answer
an idempotent retry. A stale update or delete rejects the whole group even
when it is the final operation. The group may touch each entry only once;
read and authorization decisions happen before the batch, and the expected
version/status is checked again by the conditional database write.

All Schema projection, stamping, validation, uniqueness, and lifecycle rules
still apply. `before_*` hooks run in operation order before the batch and can
veto it; their external effects cannot be rolled back. `after_*` hooks run
only after commit, in operation order. Publishing-content invalidation runs
once for the group. Deferred Queue delivery is separate from the database
transaction. Application-owned tables can use their host's transaction
facility inside a ref handler, but that does not give those tables Mantle
entry semantics. Direct SQL writes to Mantle Schema tables are unsupported.
Authorization guard Procedures do not receive `ctx.writeAtomically`.

On D1 and Bun SQLite a group reads its update and delete targets before the
batch with one query per 95 ids per Schema. The batch holds one statement per
create, two per update or delete (the conditional write and its guard) and,
when the group has any update or delete, one final cleanup: 200 updates in one
Schema cost 3 reads and 401 statements. A conflict re-reads the targets once
more to name the stale entry. D1 counts queries against a per-invocation limit;
size groups with that in mind.

## TTL sweep in a ref handler

`ctx.sweepExpired({ collection, limit })` previews a bounded page of expired rows; `delete: true` explicitly removes it. The result contains `scanned`, `removed` and an optional `nextCursor`. Continue with that cursor until absent. D1 and Bun SQLite implement this semantic capability; unsupported storage returns `RESOURCE_UNAVAILABLE`. Authorization guard Procedures do not receive the sweep function. For a scheduled cleanup, declare a [schedule Trigger](./trigger.md#schedule-source) targeting a no-input ref Procedure. No sweep is scheduled automatically. See [Schema TTL](./schema.md#ttl).

## `uiSchema`

Admin presentation only. It never affects input validation, the MCP tool schema or the OpenAPI document. Roots are closed: `collectionAction` and `fields`.

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

Each listed operation carries `name`, `title`, `description`, `input`, `uiSchema`, `triggers` (the distinct kinds that qualified it, so a Procedure can be both), `interactions` and `rowBindings`.

`interactions` come from the compiled plan (ADR-0029): each is `{ collection, bind: [{ input, field }], version?, mutates }`. Admin offers the operation from that collection's row menu and fills the bound inputs from the row, read-only. The operation target comes first: a declared `Procedure.spec.target`, or the target implied by a builtin `update`, `delete`, `archive` or id-based `upsert`. It binds the entry id and, where the Procedure takes one, `version` names the input that receives the version the person reviewed. A reference (`x-mantle-ref`) binds its input and locks nothing. With the object form `x-mantle-ref: { schema, field }`, the bound field is the declared `field`. The string form is transitional (D8): when its inferred field (a same-named property, else the lone single-field unique index) is not `id`, Admin keeps that binding without a version and logs one warning per Procedure input at mount, naming the object form to declare. The next minor release reads the string form as `field: id`. Refs to unknown collections or to translation children produce no binding and no error. `rowBindings` is the first bound input of each interaction, kept for one minor release; `targetCollection` is gone.

Admin runs every operation through the shared interaction controller, whether it is opened from a row, an entry page, a collection header or the Operations page. `expectedVersion` is no longer a magic name: it is filled only when an interaction declares it as `version`, from the entry the person reviewed. A change since the list is shown for review before anything is sent. A `CONFLICT` on a locked version keeps the input and asks for the latest version; any other refusal is shown and the person may fix and resubmit. A write whose outcome is unknown is never retried. Without an interaction, the operation is an ordinary form, and a declared `expectedVersion` is an ordinary input.

Worked end-to-end examples live in [Commerce inventory](../../examples/cf-primitives-commerce-inventory.md), [Commerce catalog](../../examples/builtin-commerce.md), and [Procurement approvals](../../examples/builtin-procurement.md).

## Source

- [`packages/mantle-spec/src/domain/model/ManifestGrammar.ts`](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [`packages/mantle-spec/src/domain/service/ManifestParser.ts`](../../../packages/mantle-spec/src/domain/service/ManifestParser.ts)
- [`packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts`](../../../packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts)
- [`packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts`](../../../packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts)
- [`packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts)
- [`packages/mantle-runtime/src/usecase/procedure/InvokeBuiltinUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeBuiltinUseCase.ts)
- [`docs/adr/0020-builtin-handler-contracts-and-matched-upsert.md`](../../adr/0020-builtin-handler-contracts-and-matched-upsert.md)
- [`docs/adr/0022-caller-observed-version-occ.md`](../../adr/0022-caller-observed-version-occ.md)
- [`packages/mantle-runtime/src/domain/service/BuiltinProjector.ts`](../../../packages/mantle-runtime/src/domain/service/BuiltinProjector.ts)
- [`packages/mantle-runtime/src/domain/model/EntryRow.ts`](../../../packages/mantle-runtime/src/domain/model/EntryRow.ts)
- [`packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts`](../../../packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts)
- [`packages/mantle-runtime/src/domain/service/io/EntryDeleteGuard.ts`](../../../packages/mantle-runtime/src/domain/service/io/EntryDeleteGuard.ts)
- [`packages/mantle-runtime/src/domain/service/CallableCapabilityProjector.ts`](../../../packages/mantle-runtime/src/domain/service/CallableCapabilityProjector.ts)
- [`packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts`](../../../packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts)
- [`packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts`](../../../packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
