---
description: A public intake form with a Turnstile bot check before the write and an email notification after it.
---
# Intake form with bot check and notification

This example collects a public request, verifies a Cloudflare Turnstile token before the row is written, and notifies staff after it is written. It extends the Builder `intake` preset with two lifecycle Triggers and two small handlers. Read it if you need any form that anonymous visitors submit.

## Problem

Visitors submit a name, an email address and a message. Staff read recent submissions in Admin, over the staff View REST route, or through Staff MCP. The public write must reject automated submissions before anything is stored, and a new row should trigger an email to the team without making the visitor wait for it or fail when email is not configured. Submissions are live records, not authored content, so the Schema is `operational`.

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
      turnstileToken: { type: string }
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
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: verify-turnstile
spec:
  input:
    type: object
    properties:
      turnstileToken: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: verify-turnstile }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: 010-requests-verify-turnstile
spec:
  source:
    kind: lifecycle
    schema: requests
    on: [before_create]
    errorPolicy: abort
  target: { procedure: verify-turnstile }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: notify-request
spec:
  input:
    type: object
    properties:
      name: { type: string }
      email: { type: string }
      message: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: notify-request }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: 020-requests-notify
spec:
  source:
    kind: lifecycle
    schema: requests
    on: [after_create]
    errorPolicy: continue
  target: { procedure: notify-request }
```

Three details carry the pattern:

- `submit-request.input` declares `turnstileToken` even though the `requests` Schema does not. The builtin `create` projects `input ∩ Schema.properties`, so the token is never stored. Because the input sets `additionalProperties: false`, the token must be declared or the request fails with `INPUT_VALIDATION_FAILED`.
- `before_create` hooks receive the original, pre-projection input, so `verify-turnstile` can read the token. Its own `input` schema must not set `additionalProperties: false`; it receives `name`, `email` and `message` too.
- `after_create` hooks receive the persisted `entry.data`. The token is gone by then, which is why verification cannot be an `after_*` hook.

Lifecycle Triggers on the same `(schema, hook)` run alphabetically by `metadata.name`; the `010-`/`020-` prefixes make the order explicit. See [Writes: Procedures, Triggers and hooks](../concepts/procedures-and-triggers.md).

## Worker and handlers

```ts
// src/handlers.ts
import { InvokeFailure, type HandlerContext } from "@aotter/mantle/runtime";
import { runtimeDiagnostic } from "@aotter/mantle/spec";
import type { Env } from "./index.js";

interface SiteverifyResult {
  readonly success?: boolean;
  readonly "error-codes"?: readonly string[];
}

export async function verifyTurnstile(
  input: { readonly turnstileToken?: string },
  ctx: HandlerContext<Env>,
): Promise<{ ok: true }> {
  const secret = ctx.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return { ok: true }; // fail-open until the secret exists; see below

  const token = input.turnstileToken?.trim();
  if (!token) reject("Turnstile verification is required.");

  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const result = response.ok
    ? ((await response.json().catch(() => null)) as SiteverifyResult | null)
    : null;
  if (!result?.success) reject("Turnstile verification failed.", result?.["error-codes"]);
  return { ok: true };
}

function reject(message: string, value?: unknown): never {
  throw new InvokeFailure(
    runtimeDiagnostic({
      code: "LIFECYCLE_HOOK_REJECTED",
      severity: "error",
      path: "/turnstileToken",
      value,
      expected: "a valid Cloudflare Turnstile token",
      message,
    }),
  );
}

export async function notifyRequest(
  input: { readonly name?: string; readonly email?: string; readonly message?: string },
  ctx: HandlerContext<Env>,
): Promise<{ ok: true }> {
  const { EMAIL, INTAKE_NOTIFY_TO, INTAKE_NOTIFY_FROM } = ctx.env;
  if (!EMAIL || !INTAKE_NOTIFY_TO || !INTAKE_NOTIFY_FROM) {
    console.info("[requests] notification not configured", { entry: ctx.event?.entry?.id });
    return { ok: true }; // fail-soft: the row is already committed
  }
  await EMAIL.send({
    to: INTAKE_NOTIFY_TO,
    from: INTAKE_NOTIFY_FROM,
    subject: `New request from ${input.name ?? "website"}`,
    text: [`Name: ${input.name ?? ""}`, `Email: ${input.email ?? ""}`, "", input.message ?? ""].join("\n"),
    ...(input.email ? { replyTo: input.email } : {}),
  });
  return { ok: true };
}
```

```ts
// src/index.ts
import { createMantleWorker, type MantleCloudflareEnv } from "@aotter/mantle/cloudflare";
import { plan, type MantleHandlers } from "../.mantle/generated/mantle.js";
import { notifyRequest, verifyTurnstile } from "./handlers.js";

interface EmailBinding {
  send(message: { to: string; from: string; subject: string; text?: string; replyTo?: string }): Promise<unknown>;
}

export interface Env extends MantleCloudflareEnv {
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly EMAIL?: EmailBinding;
  readonly INTAKE_NOTIFY_TO?: string;
  readonly INTAKE_NOTIFY_FROM?: string;
}

const handlers = {
  "verify-turnstile": verifyTurnstile,
  "notify-request": notifyRequest,
} satisfies MantleHandlers<Env>;

export default createMantleWorker<Env>({ plan, extend: () => ({ handlers }) });
```

The keys of `handlers` are the opaque `handler.ref` strings from the Manifest. A missing key fails at boot with `HANDLER_NOT_REGISTERED`.

Bindings live in `wrangler.toml`: `[[send_email]] name = "EMAIL"` for Cloudflare Email Service, `INTAKE_NOTIFY_TO` and `INTAKE_NOTIFY_FROM` as vars, and `TURNSTILE_SECRET_KEY` as a secret (`wrangler secret put TURNSTILE_SECRET_KEY`). See [Bindings and primitives](../cloudflare/bindings.md).

Two policies are deliberate and reversible:

- **Bot check fails open when the secret is unset.** A first deployment without Turnstile configured still accepts submissions instead of rejecting every visitor with an opaque error. To fail closed, replace `if (!secret) return { ok: true }` with `if (!secret) reject("Turnstile is not configured.")`.
- **Notification fails soft.** The Trigger's `errorPolicy: continue` means a throwing `after_create` handler is logged and never rolls back the row; the handler additionally returns `ok` when the binding is absent so logs stay quiet. If you later route `after_*` hooks through a Queue, keep the handler idempotent as described in [Deferred hooks with Queues](../cloudflare/deferred-hooks-queues.md).

> **Warning**
> The runtime does not substitute an error code when a `before_*` hook aborts; the caller receives exactly the diagnostic the hook threw. This handler throws `LIFECYCLE_HOOK_REJECTED` (409). Throwing `INPUT_VALIDATION_FAILED` (400) is equally valid if you prefer to treat a missing token as a malformed request.

## Try it

Submit a request:

```sh
curl -sS -X POST http://localhost:8787/api/requests \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.test","message":"Please call me back.","turnstileToken":"<token>"}'
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

The builtin `create` returns the `EntryRow`; `status` is `published` immediately because the Schema is operational. A rejected token, with the secret configured:

```json
{
  "ok": false,
  "diagnostic": {
    "code": "LIFECYCLE_HOOK_REJECTED",
    "phase": "runtime",
    "severity": "error",
    "path": "/turnstileToken",
    "expected": "a valid Cloudflare Turnstile token",
    "message": "Turnstile verification failed."
  }
}
```

That response is HTTP 409 and no row exists. A missing `name` is HTTP 400 `INPUT_VALIDATION_FAILED` before any hook runs.

Staff read the queue at `GET /admin/api/views/recent-requests?page=1&show=50` with a staff session; the envelope is `{ ok, data: { rows, page, show, hasMore } }`.

MCP tools:

| Surface | Tool | Origin |
|---|---|---|
| `/mcp` | `submit_request` | `submit-request-mcp` Trigger |
| `/mcp/staff` | `query_view_recent_requests` | `recent-requests` View |
| `/mcp/staff` | `create_record_requests`, `update_record_requests` | operational Schema `requests` |

An agent calling `submit_request` on `/mcp` has no browser Turnstile widget. With the secret unset the call succeeds; with the secret set it is rejected unless the agent supplies a valid token. Keep or remove `submit-request-mcp` deliberately.

## What this deliberately leaves out

- **Deduplication.** Two identical submissions create two rows. Add a `uniqueIndexes` tuple or a `before_create` lookup if duplicates matter.
- **Rate limiting beyond Turnstile.** The adapter applies its own request limits to Auth and Admin routes, not a per-form quota.
- **CRM sync.** Forwarding rows to an external system belongs in another `after_create` handler, ideally deferred through a Queue with the `${ctx.event.id}:${ctx.event.trigger}` idempotency key.

Related: [Reservation requests](./reservation.md) uses the same builtin-create shape without hooks; [Procurement approvals](./procurement-approvals.md) adds member and staff roles.

## Source

- [`docs/design-atoms.md`](../../../docs/design-atoms.md) — builtin table, side-channel input fields, lifecycle hooks
- [`packages/mantle-runtime/src/usecase/lifecycle/RunLifecycleHooksUseCase.ts`](../../../packages/mantle-runtime/src/usecase/lifecycle/RunLifecycleHooksUseCase.ts) — abort propagates the hook's diagnostic
- [`packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts) — `InvokeFailure`
- [`packages/mantle-spec/src/kernel/diagnostic.ts`](../../../packages/mantle-spec/src/kernel/diagnostic.ts) — `LIFECYCLE_HOOK_REJECTED` → 409
- [`overlays/presence/manifests/site.yaml`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/presence/manifests/site.yaml) — retired contact-form pattern
- [`overlays/presence/src/worker/features/contact/notifyContact.ts`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/presence/src/worker/features/contact/notifyContact.ts)
- [`recipes/typed-web/src/worker/lib/turnstile.ts`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/recipes/typed-web/src/worker/lib/turnstile.ts)
