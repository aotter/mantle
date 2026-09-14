---
description: Trigger field reference — http, mcp and lifecycle sources, path and tool-name rules, the eight lifecycle hooks and their timing and error policy.
---
# Trigger

A Trigger binds one source to one [Procedure](./procedure.md). Every external surface for a write — an HTTP endpoint, an MCP tool, an entry-lifecycle hook — is a Trigger, and there is no other way to expose a Procedure. This page is the field-level contract; the concepts are in [Procedures and Triggers](../concepts/procedures-and-triggers.md). Envelope rules are in [Manifest envelope and conventions](./manifest.md), and diagnostic codes are catalogued in [Diagnostics](./diagnostics.md).

## Fields

`spec` accepts exactly two keys.

| Field | Type | Required | Rules |
|---|---|---|---|
| `source` | mapping | yes | Discriminated by `kind`; the accepted sibling keys depend on it. |
| `target` | `{ procedure }` | yes | Only the key `procedure`, naming a declared Procedure (`TRIGGER_TARGET_PROCEDURE_UNKNOWN`). |

| `source.kind` | Other keys | Binds |
|---|---|---|
| `http` | `method`, `path` | One REST endpoint under `/api/`. |
| `mcp` | `surface` | One tool on `/mcp` or `/mcp/staff`. |
| `lifecycle` | `schema`, `on`, `errorPolicy` | Entry-writer hooks on one Schema. |

An unknown `kind`, a missing `kind`, or a key that does not belong to the chosen kind is `INVALID_MANIFEST_ENVELOPE`. One Procedure may carry several Triggers — that is how the same handler becomes an HTTP endpoint and an MCP tool without duplicating logic.

## `http` source

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: inventory-level-http
spec:
  source:
    kind: http
    method: PUT
    path: /api/inventory/{sku}/level
  target:
    procedure: sync-inventory-level
```

| Field | Rules |
|---|---|
| `method` | `POST`, `PUT`, `PATCH` or `DELETE`. |
| `path` | Non-empty string starting with `/`. OpenAPI `{param}` syntax for path params. No optional segments. |

`GET` is deliberately absent. Reads are [Views](./view.md), which mount themselves from `surface` and need no Trigger at all; a Procedure is a write.

### Path rules

| Phase | Rule | Diagnostic |
|---|---|---|
| parse | `path` starts with `/`. | `INVALID_MANIFEST_ENVELOPE` |
| validate | `path` starts with `/api/`, so adapters can route public pages and Procedure endpoints without ambiguity. | `TRIGGER_PATH_INVALID` |
| validate | `(method, path)` is unique across every `http` Trigger. | `TRIGGER_PATH_COLLISION`, naming the Trigger that claimed it first. |
| boot | `path` falls outside the adapter's reserved prefixes. | `TRIGGER_PATH_INVALID` |

Only well-prefixed paths are tracked for collisions, so a path missing `/api/` produces one diagnostic rather than two. The Cloudflare Worker reserves `/admin`, `/_mantle`, `/api/auth`, `/api/views`, `/oauth`, `/mcp`, anything starting `/.well-known/oauth`, and the exact registrations `*` and `/*`; a prefix matches the path itself or a `/` or `{` boundary after it. See [Conventional Worker](../cloudflare/conventional-worker.md).

### Routing and binding

| Behavior | Detail |
|---|---|
| Path params | Each `{param}` binds to the identically named field on the target Procedure's `input`, which must declare it. |
| Precedence | The invocation merges the body first and the path params second, so **the path wins** over a same-named body field. |
| Trailing slash | `/api/posts` and `/api/posts/` are the same route; the root `/` is preserved. |
| Percent-encoding | Each request segment is decoded once, so `/api/by%2Dtag` matches the literal `/api/by-tag`. Malformed encoding such as `%GG` is a routing miss (404), not a 500. |
| Body | Must be a JSON object. Anything else is `INPUT_VALIDATION_FAILED` (400) with *HTTP Trigger request body must be a JSON object*. A body over 1 MiB is the same code at 413. |
| Empty body | A `DELETE`, or any request without a JSON content type, is treated as `{}` — bind those inputs through path params. |

A success is `{ "ok": true, "data": <handler result> }`; a failure is `{ "ok": false, "diagnostic": ... }` at the diagnostic's mapped status. `http` Triggers are also what the OpenAPI emitter projects into operations.

## `mcp` source

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: approve-purchase-order-mcp
spec:
  source:
    kind: mcp
    surface: staff
  target:
    procedure: approve-purchase-order
```

| `surface` | Endpoint | Gate |
|---|---|---|
| `public` | `/mcp` | Bearer token. |
| `staff` | `/mcp/staff` | Bearer token plus a staff role read from storage on every invocation. |

`surface` is **discovery only**. It decides which tools appear in `tools/list` on which endpoint; it authorizes nothing. The target Procedure's `requires.auth.all` predicates and its optional guard are re-evaluated on every `tools/call` against the authenticated caller, exactly as they are over HTTP. A `public`-surface Procedure that requires `ctx.staff` is discoverable on `/mcp` and will still be denied there.

The tool name is derived from the **Procedure's** `metadata.name`, not the Trigger's: lower-cased, with `-` replaced by `_`. Only one Trigger may claim a given `(surface, tool name)` pair; a second is `MCP_TOOL_NAME_COLLISION`. The same code also fires when the mangled name hits a reserved generic tool name or prefix, or a Schema's or another Procedure's segment — see [Reserved names](./manifest.md#reserved-names).

The tool carries the Procedure's `title` and `description`, with a short authorization summary appended to the description. `output` is not surfaced; MCP clients infer the response shape from the `tools/call` result. See [MCP and agents](../concepts/mcp-and-agents.md).

## `lifecycle` source

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: 010-verify-purchase-token
spec:
  source:
    kind: lifecycle
    schema: purchase-orders
    on: [before_create]
    errorPolicy: abort
  target:
    procedure: verify-purchase-token
```

| Field | Type | Required | Default | Rules |
|---|---|---|---|---|
| `schema` | string | yes | — | A declared Schema (`LIFECYCLE_SCHEMA_UNKNOWN`). |
| `on` | `LifecycleHook[]` | yes | — | Non-empty; every entry from the closed list below. |
| `errorPolicy` | `abort` \| `continue` | no | `abort` for `before_*`, `continue` for `after_*` | See below. |

`errorPolicy: abort` is rejected at parse time when **any** `after_*` hook appears in `on`: an `after_*` hook runs once the response has already been sent, so an abort could never reach the caller. Split the `after_*` hooks into their own Trigger, or declare `continue`.

> **Info**
> `Schema.spec.lifecycle` (`publishing` / `operational`) is a different domain that shares the word. That setting governs which states an entry may be in; a lifecycle Trigger governs what fires around a mutation. See [Schema](./schema.md#lifecycle).

### Hooks

| Hook | Fires |
|---|---|
| `before_create` | Before the insert. |
| `after_create` | After the insert. |
| `before_update` | Before an update **or** any status transition whose target is not `published` — this includes unpublish and archive. |
| `after_update` | After an update or such a transition. |
| `before_delete` | Before the delete. |
| `after_delete` | After the delete, only when a row was actually removed. |
| `before_publish` | Before a transition to `published`. |
| `after_publish` | After a transition to `published`. |

There are no unpublish-specific or archive-specific hooks. Do not read `before_update` / `after_update` as edit-only.

### Error policy

| Phase | Default | Behavior |
|---|---|---|
| `before_*` | `abort` | A throwing hook cancels the surrounding mutation and the caller receives the hook's own diagnostic. A hook that rejects a write on purpose raises `LIFECYCLE_HOOK_REJECTED` (409). Under `continue` the failure is logged and the mutation proceeds. |
| `after_*` | `continue` | The committed mutation stands. On the inline or `waitUntil` path a failure is logged and swallowed. With a deferred dispatcher wired in, the failure reaches the delivery adapter so its at-least-once retry and dead-letter policy can run. Neither path ever rolls back. |

### Handler input and `ctx.event`

Hook input is phase-specific.

| Phase | Handler input |
|---|---|
| `before_*` | The original **pre-projection** Procedure input, so a hook can read side-channel fields the row never stores — a CAPTCHA token, a client nonce. It falls back to the row's `data` when there is no caller input. |
| `after_*` | The persisted `entry.data` only. Deferred envelopes deliberately never carry arbitrary request input. |

Every hook handler also receives `ctx.event`:

| Field | Value |
|---|---|
| `id` | Stable event id, unchanged across enqueue fallback and deferred retries. |
| `trigger` | The firing Trigger's `metadata.name`. |
| `hook` | The hook name. |
| `schema` | The watched Schema name. |
| `entry` | `null` only on `before_create`; the pre-mutation row for the other `before_*` hooks; the persisted post-mutation row for every `after_*`. |

Deferred handlers key on `${ctx.event.id}:${ctx.event.trigger}`. See [Procedure](./procedure.md#conflicts-and-idempotency).

### Ordering and coverage

When several lifecycle Triggers bind the same `(schema, hook)`, they fire **alphabetically by `Trigger.metadata.name`**. Choose names that sort the way you want them to run — the `010-`, `020-` convention exists for exactly this, and the code generator handles the leading digits.

Hooks are wired through a repository decorator that wraps the single entry-writer chokepoint, so **Staff MCP, Admin and builtin Procedure writes all fire the same hooks**. There is no write path that bypasses them.

For deferred `after_*` delivery, the ordered Trigger-name list is captured into one versioned envelope carrying the persisted row and a small identity snapshot. Every captured Trigger runs before a failure is reported back, so a retry may replay Triggers that already succeeded — hence the idempotency key. Queue acceptance is not transactional with the entry write, the `waitUntil` fallback is best-effort, and exactly-once is not promised. See [Deferred hooks on Queues](../cloudflare/deferred-hooks-queues.md).

## Source

- [`packages/mantle-spec/src/domain/model/ManifestGrammar.ts`](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [`packages/mantle-spec/src/domain/service/ManifestParser.ts`](../../../packages/mantle-spec/src/domain/service/ManifestParser.ts)
- [`packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts`](../../../packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts)
- [`packages/mantle-spec/src/domain/service/McpToolNaming.ts`](../../../packages/mantle-spec/src/domain/service/McpToolNaming.ts)
- [`packages/mantle-runtime/src/domain/service/PathMatcher.ts`](../../../packages/mantle-runtime/src/domain/service/PathMatcher.ts)
- [`packages/mantle-runtime/src/domain/service/TriggerIndex.ts`](../../../packages/mantle-runtime/src/domain/service/TriggerIndex.ts)
- [`packages/mantle-runtime/src/usecase/lifecycle/RunLifecycleHooksUseCase.ts`](../../../packages/mantle-runtime/src/usecase/lifecycle/RunLifecycleHooksUseCase.ts)
- [`packages/mantle-runtime/src/infrastructure/persistence/LifecycleHookingEntryRepository.ts`](../../../packages/mantle-runtime/src/infrastructure/persistence/LifecycleHookingEntryRepository.ts)
- [`packages/mantle-runtime/src/domain/port/DeferredHookDispatcher.ts`](../../../packages/mantle-runtime/src/domain/port/DeferredHookDispatcher.ts)
- [`packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts`](../../../packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts)
- [`packages/mantle-runtime/src/infrastructure/http/readJsonBody.ts`](../../../packages/mantle-runtime/src/infrastructure/http/readJsonBody.ts)
- [`packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts`](../../../packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts)
- [`packages/mantle/src/codegen/emitMantleModule.ts`](../../../packages/mantle/src/codegen/emitMantleModule.ts)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
- [`packages/adapters/cloudflare/src/mount/mountMcp.ts`](../../../packages/adapters/cloudflare/src/mount/mountMcp.ts)
- [`docs/design-atoms.md`](../../../docs/design-atoms.md)
