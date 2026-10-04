---
description: A public intake form with a Turnstile bot check as the Procedure's guard and a staff email from an after hook.
---
# Intake form with bot check and notification

[Examples hub](./README.md) · Without the bot check and email, this is [Intake form](./intake.md).

Anonymous visitors submit a request. A Cloudflare Turnstile token is verified
before anything is written, and staff get an email after the row is committed.
The write stays one SQL statement; two small `ref` handlers carry the
integrations.

## Problem

The public write must reject automated submissions before anything is stored.
A new row should email the team, without making the visitor wait for the email
or fail when email is not configured. Submissions are records, so the Schema is
`operational`.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: requests }
spec:
  title: Requests
  description: Requests submitted through the public intake form.
  lifecycle: operational
  schema:
    type: object
    additionalProperties: false
    required: [name, email, message]
    properties:
      name: { type: string, minLength: 1, maxLength: 120 }
      email: { type: string, format: email }
      message: { type: string, minLength: 1, maxLength: 2000 }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: recent-requests }
spec:
  title: Recent requests
  surface: staff
  requires: { auth: { all: [{ ctx.staff: [owner, editor, contributor] }] } }
  sql: |
    SELECT id, name, email, message, created_at FROM requests
    ORDER BY created_at DESC LIMIT 50
---
# The guard runs first, with this Procedure's validated input, token included. The INSERT never stores the token.
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: submit-request }
spec:
  title: Submit request
  description: Create a new public request after a Turnstile check.
  requires: { guard: { procedure: verify-turnstile } }
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
  handler:
    sql: |
      INSERT INTO requests (name, email, message)
      VALUES (input.name, input.email, input.message)
      RETURNING id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: verify-turnstile }
spec:
  input:
    type: object
    properties:
      turnstileToken: { type: string }
  output: { type: object }
  handler: { ref: verifyTurnstile }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: notify-requests }
spec:
  input: { type: object }
  output: { type: object }
  handler: { ref: notifyRequests }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submit-request-http }
spec:
  source: { kind: http, method: POST, path: /api/requests }
  target: { procedure: submit-request }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submit-request-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: submit-request }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: requests-notify }
spec:
  source: { kind: lifecycle, schema: requests, on: [after_create] }
  target: { procedure: notify-requests }
```

Why each check sits where it does:

- **The bot check is a guard, not a before hook.** A guard receives the target
  Procedure's validated input, so it can read `turnstileToken`. A before hook
  receives only the row about to be written (`ctx.cause.rows`), and the token is
  never part of the row. A guard belongs to one Procedure, which is right here:
  staff creating a row through Admin are not asked for a token.
- **The guard's input schema leaves `additionalProperties` open.** It receives
  `name`, `email` and `message` too.
- **The email is an after hook.** It runs only after the commit, and a failure
  never undoes the row. One statement can write many rows, so the handler loops
  over `ctx.cause.rows`.

## Handlers

```ts
// src/handlers.ts
import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle";
import type { MantleHandlers } from "../.mantle/generated/mantle.js";
import type { Env } from "./service.js";

const reject = (message: string, value?: unknown): never => {
  throw new DiagnosticError(runtimeDiagnostic({ code: "AUTH_DENIED", severity: "error", path: "/turnstileToken", value, message }));
};

export const handlers: MantleHandlers<Env> = {
  verifyTurnstile: async (input, ctx) => {
    const secret = ctx.env.TURNSTILE_SECRET_KEY?.trim();
    if (!secret) return {}; // fails open until the secret exists; see below
    const token = (input as { turnstileToken?: string }).turnstileToken?.trim();
    if (!token) reject("Turnstile verification is required.");
    const body = new FormData();
    body.set("secret", secret);
    body.set("response", token!);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const result = response.ok ? ((await response.json().catch(() => null)) as { success?: boolean; "error-codes"?: string[] } | null) : null;
    if (!result?.success) reject("Turnstile verification failed.", result?.["error-codes"]);
    return {};
  },

  // an after hook gets every row the statement wrote: loop, never rows[0]
  notifyRequests: async (_input, ctx) => {
    const { EMAIL, INTAKE_NOTIFY_TO, INTAKE_NOTIFY_FROM } = ctx.env;
    if (ctx.cause.kind !== "lifecycle" || !EMAIL || !INTAKE_NOTIFY_TO || !INTAKE_NOTIFY_FROM) return {};
    for (const row of ctx.cause.rows) {
      await EMAIL.send({
        to: INTAKE_NOTIFY_TO,
        from: INTAKE_NOTIFY_FROM,
        subject: `New request from ${String(row.name)}`,
        text: [`Name: ${String(row.name)}`, `Email: ${String(row.email)}`, "", String(row.message)].join("\n"),
        replyTo: String(row.email),
      });
    }
    return {};
  },
};
```

`src/service.ts` is the application's own file after the first
`mantle generate`. Add the bindings to its `Env`:

```ts
interface EmailBinding {
  send(message: { to: string; from: string; subject: string; text?: string; replyTo?: string }): Promise<unknown>;
}

export interface Env {
  readonly DB: D1Database;
  // ...the generated fields...
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly EMAIL?: EmailBinding;
  readonly INTAKE_NOTIFY_TO?: string;
  readonly INTAKE_NOTIFY_FROM?: string;
}
```

Put `send_email` (`[{ "name": "EMAIL" }]`) and the two `vars` in
`wrangler.jsonc`, and set the secret with
`wrangler secret put TURNSTILE_SECRET_KEY`.

A handler throws `DiagnosticError` to answer with that code's status
(`AUTH_DENIED` is 403). Any other throw is logged and answered as 500
`INTERNAL_ERROR`. Import it from `@aotter/mantle`, not `@aotter/mantle/spec`:
the root carries no SQL parser, while `/spec` bundles it into the Worker.

Two policies are deliberate:

- **The bot check fails open while the secret is unset,** so a first deploy
  still accepts submissions. To fail closed, make the missing secret a
  `reject(...)`.
- **The notification fails soft.** After hooks are best effort: a throw is
  logged and the row stays. `ctx.cause.id` is stable across a replay, so a
  handler that must not send twice can deduplicate on it.

## Try it

```sh
curl -sS -X POST http://127.0.0.1:8787/api/requests \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.test","message":"Please call me back.","turnstileToken":"<token>"}'
```

The answer is `{ "results": [[{ "id": "…" }]] }`. With the secret set, a bad
token is HTTP 403 with `{ "error": { "code": "AUTH_DENIED", … } }`, and no row
exists. A missing `name` is HTTP 400 `INPUT_VALIDATION_FAILED` before the guard
runs.

An agent calling `submit_request` on `/mcp` has no browser widget. With the
secret set, it is refused unless it brings a valid token. Keep or remove
`submit-request-mcp` deliberately.

## What this leaves out

- **Deduplication.** Add a `uniqueIndexes` tuple and `ON CONFLICT DO NOTHING`
  if duplicates matter.
- **Rate limiting beyond Turnstile.** Put a quota in the service's own `fetch`.
- **Reliable delivery.** After hooks run inline after the commit. A CRM sync
  that must not be lost needs the service's own queue or outbox.

## Source

- [Writes: Procedures, Triggers and hooks](../handbook/concepts/procedures-and-triggers.md)
- [Authorization reference](../handbook/reference/authorization.md): guards
