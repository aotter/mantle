---
description: How writes work — typed Procedures with a code seam, the three Trigger kinds that bind them, builtin ops, lifecycle hooks and the HTTP envelope.
---
# Writes: Procedures, Triggers and lifecycle hooks

Every write goes through a Procedure, and every Procedure that anything outside the runtime can reach has a Trigger. This page explains the split and the lifecycle hook contract. Field-level rules are in the [Procedure](../reference/procedure.md) and [Trigger](../reference/trigger.md) references.

## A Procedure is a callable, not an endpoint

A Procedure declares typed `input`, typed `output`, optional `requires`, and one `handler`. It contains no path, no method and no tool name; it is transport-agnostic on purpose, so calling a Procedure name as a URL returns `404`. Exposing a write is a separate, explicit decision.

Invocation runs in a fixed order: static auth predicates, input validation, the optional guard Procedure, the handler, then output validation — which checks the returned value but does not strip extra fields.

The Procedure is also the only atom with a code seam. `handler: { kind: ref, ref: <key> }` names an opaque registration key — not a file path — that your project maps to a function in its `handlers` object. A key with no registered function fails at boot with `HANDLER_NOT_REGISTERED`.

## A Trigger is the only binding

`Trigger.spec.target.procedure` names a declared Procedure; `spec.source` says what reaches it. There are three source kinds.

| `source.kind` | Binds to | Notes |
|---|---|---|
| `http` | `method` and `path` | `POST`, `PUT`, `PATCH`, `DELETE` only. `GET` is absent because reads belong to [Views](./views.md). The path must start `/api/`, must not collide with another Trigger or an adapter-reserved prefix, and may use OpenAPI `{param}` segments that auto-bind to same-named input fields. |
| `mcp` | `surface: public` or `staff` | The tool is named after the Procedure, lowercased with hyphens replaced by underscores. Surface controls discovery only; `requires` is re-evaluated on every `tools/call`. |
| `lifecycle` | `schema`, `on: [<hook>]`, optional `errorPolicy` | Fires around entry mutations. See [Lifecycle hooks](#lifecycle-hooks). |

One Procedure may carry several Triggers, and that is how the same handler becomes an HTTP endpoint, an MCP tool and a hook without duplicated logic. Adding a transport is additive: write another Trigger, leave the Procedure alone.

## Builtin or `ref`

`handler.kind: builtin` is a thin shortcut over the storage adapter. The rule is simple: **use `builtin` when the body of the operation is "insert a row", "update a row" or "delete a row"; reach for `ref` when there is real business logic.** A guard Procedure can never be builtin.

| `op` | What it does | Input contract |
|---|---|---|
| `create` | Projects `input ∩ Schema.properties`, stamps `x-mantle-bind` fields, inserts. Status is `draft`, or `published` for an operational Schema. Returns the created `EntryRow`. | An object schema |
| `update` | Loads, merges the patch, bumps `version` under optimistic concurrency | `id` (strict string) and `expectedVersion` (strict number), both required |
| `upsert` | With `match`, looks the row up by natural key and updates it, otherwise creates | `match` equals one `uniqueIndexes` tuple exactly, in order; no `id` or `expectedVersion` |
| `delete` | Hard delete by id | `id` (strict string) required |
| `archive` | Transitions to `archived`, or `CONFLICT` if the machine disallows it | `id` required; publishing Schemas only |

`request_publish` and `publish` are deliberately not builtin ops. They are lifecycle operations, not CRUD primitives.

Every builtin write runs the same guards: locale gate, then a unique-index preflight. A race that slips past the preflight is caught by the database constraint and surfaces as `CONFLICT` (409) with no automatic retry.

### Side-channel input fields

A Procedure's `input` is the contract with the caller, not with the Schema. It may declare fields the Schema does not — a Turnstile token, a honeypot value, a referrer. The builtin op projects `input ∩ Schema.properties` and silently drops the rest, so nothing extra is stored.

Those fields are still readable where it matters: a `before_create` or `before_update` hook receives the **original, pre-projection** input. Every `after_*` hook receives only the persisted `entry.data`. That asymmetry is why bot checks are `before_*` hooks and notifications are `after_*` hooks.

## Lifecycle hooks

| Hook | Fires | Default `errorPolicy` |
|---|---|---|
| `before_create` | Before insert | `abort` |
| `after_create` | After insert | `continue` |
| `before_update` | Before an update, or a status transition whose target is not `published` | `abort` |
| `after_update` | After an update, or a status transition whose target is not `published` | `continue` |
| `before_delete` | Before delete | `abort` |
| `after_delete` | After delete | `continue` |
| `before_publish` | Before a transition to `published` | `abort` |
| `after_publish` | After a transition to `published` | `continue` |

> **Update hooks are not edit-only**
> There are no unpublish-specific or archive-specific hooks. `before_update` and `after_update` also fire for unpublish, archive and every other transition whose target is not `published`. A hook that assumes "the row was edited" will run on state changes you did not intend.

`abort` means a throwing handler cancels the surrounding mutation and the caller receives `LIFECYCLE_HOOK_REJECTED` (409). `continue` means the committed mutation stands: on the inline or `waitUntil` path the failure is logged and swallowed. Authors may set `errorPolicy` explicitly, but `abort` is rejected on a Trigger whose `on` list contains any `after_*` hook — a committed write cannot be un-committed.

Hooks are wired through the entry repository, so Admin, Staff MCP and builtin Procedures all fire the same hooks. When several lifecycle Triggers bind the same schema and hook, they fire **alphabetically by `Trigger.metadata.name`**; number them (`010-bot-check`, `020-rate-limit`) so the order is visible.

Handlers receive `ctx.event = { id, trigger, hook, schema, entry }`. `id` is stable across retries, `trigger` is the current Trigger name, and `entry` is `null` only for `before_create`; otherwise it is the pre-mutation row for `before_*` and the persisted row for `after_*`.

### Deferred `after_*` delivery

With an optional `DeferredHookDispatcher`, `after_*` hooks leave the request path and run under the delivery adapter's at-least-once retry and dead-letter policy instead of being swallowed. Delivery is not transactional with the database and exactly-once is not promised, so handlers must be idempotent; the conventional key is `${ctx.event.id}:${ctx.event.trigger}`. Cloudflare wiring, the envelope and DLQ configuration are in [Deferred hooks with Queues](../cloudflare/deferred-hooks-queues.md).

## The HTTP envelope

An HTTP Trigger wraps the handler's result as `{ "ok": true, "data": <result> }`, or returns the redacted diagnostic with the code's mapped status:

```json
{ "ok": false, "diagnostic": { "code": "INPUT_VALIDATION_FAILED", "path": "POST /api/contact#/name" } }
```

For a builtin `create`, `data` is the whole `EntryRow`: `id`, `collection`, `status`, `version`, `data`, nullable `authorId`, millisecond `createdAt` and `updatedAt`, and `locale` on localized rows. Declare `spec.output` against that row, not against the envelope. The request body must be a JSON object; anything else is a 400, and an oversize body is a 413.

| Code | HTTP | When |
|---|---|---|
| `INPUT_VALIDATION_FAILED` | 400 | Input fails the converted schema, or the body is not a JSON object |
| `UNAUTHENTICATED` | 401 | No verified credential at all |
| `ENTITLEMENT_REQUIRED` | 402 | A guard Procedure denied the current business entitlement |
| `AUTH_DENIED` | 403 | Authenticated, but a `requires.auth` predicate was false |
| `NOT_FOUND` | 404 | Unknown entry id or View name |
| `CONFLICT` | 409 | Illegal lifecycle transition, or a unique-index collision |
| `LIFECYCLE_HOOK_REJECTED` | 409 | A `before_*` hook aborted the mutation |
| `OUTPUT_VALIDATION_FAILED` | 500 | The handler returned a value its `output` schema rejects |
| `HANDLER_NOT_REGISTERED` | 500 | A `ref` key has no registered function |
| `INTERNAL_ERROR` | 500 | Uncaught handler exception |

The full catalog is in [Diagnostic codes](../reference/diagnostics.md).

## Worked example: a contact form

One builtin write, one `before_create` check that can abort it, one `after_create` notification that cannot.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: contact-messages
spec:
  title: Contact messages
  lifecycle: operational
  schema:
    type: object
    additionalProperties: false
    required: [name, email, message]
    properties:
      name: { type: string, minLength: 1, maxLength: 80 }
      email: { type: string, format: email }
      message: { type: string, minLength: 1, maxLength: 4000 }
      submittedAt: { type: integer, x-mcp-hint: timestamp-ms, x-mantle-bind: now }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: send-contact-message
spec:
  title: Send contact message
  input:
    type: object
    additionalProperties: false
    required: [name, email, message, botToken]
    properties:
      name: { type: string, minLength: 1, maxLength: 80 }
      email: { type: string, format: email }
      message: { type: string, minLength: 1, maxLength: 4000 }
      botToken: { type: string, minLength: 1 }
  output:
    type: object
    required: [id]
    properties:
      id: { type: string }
  handler: { kind: builtin, op: create, schema: contact-messages }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: contact-http
spec:
  source: { kind: http, method: POST, path: /api/contact }
  target: { procedure: send-contact-message }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: check-contact-bot
spec:
  input:
    type: object
    properties:
      botToken: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: check-contact-bot }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: 010-contact-bot-check
spec:
  source:
    kind: lifecycle
    schema: contact-messages
    on: [before_create]
    errorPolicy: abort
  target: { procedure: check-contact-bot }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: notify-contact-message
spec:
  input:
    type: object
    properties:
      name: { type: string }
      email: { type: string }
      message: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: notify-contact-message }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: 020-contact-notify
spec:
  source:
    kind: lifecycle
    schema: contact-messages
    on: [after_create]
    errorPolicy: continue
  target: { procedure: notify-contact-message }
```

What each piece is doing:

- `botToken` is declared on the Procedure input but not on the Schema, so it is validated, read by the hook, and never stored.
- `010-contact-bot-check` runs first because Triggers on the same hook fire alphabetically. Throwing from its handler cancels the insert and the caller receives 409 `LIFECYCLE_HOOK_REJECTED`; nothing is written.
- `020-contact-notify` runs after the row exists and receives only `entry.data`. A failing mailer is logged, not fatal — the visitor's message is already saved.
- `submittedAt` is stamped by the runtime, so it is absent from the Procedure input and from Staff MCP authoring tools.
- Adding `{ kind: mcp, surface: public }` as a fourth Trigger would publish the same Procedure as an agent tool without touching a handler.

Register the two `ref` keys in the project's handlers map, then run the check loop from [Project layout and the CLI loop](../start/project-and-cli.md). The complete version with real Turnstile and email handlers is [Intake form](../examples/intake-form.md).

## Source

- [`docs/design-atoms.md`](../../../docs/design-atoms.md)
- [`docs/adr/0001-four-atom-manifest-model.md`](../../../docs/adr/0001-four-atom-manifest-model.md)
- [`docs/deferred-lifecycle-queues.md`](../../../docs/deferred-lifecycle-queues.md)
- [`packages/mantle-spec/src/domain/model/ManifestGrammar.ts`](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [`packages/mantle-runtime/src/domain/service/BuiltinProjector.ts`](../../../packages/mantle-runtime/src/domain/service/BuiltinProjector.ts)
- [`packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts`](../../../packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts)
- [`skills/develop/SKILL.md`](../../../skills/develop/SKILL.md)
