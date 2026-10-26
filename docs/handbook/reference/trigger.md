# Trigger

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: tickets }
spec:
  title: Tickets
  lifecycle: operational
  schema: { type: object, required: [closed], properties: { closed: { type: boolean } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: close-ticket }
spec:
  requires: { auth: { all: [ctx.admin] } }
  input: { type: object, required: [id, version], properties: { id: { type: string }, version: { type: integer } }, additionalProperties: false }
  output: { type: object }
  handler: { sql: 'UPDATE tickets SET closed=true WHERE id=input.id AND version=input.version RETURNING id,closed' }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: close-ticket-http }
spec:
  source: { kind: http, method: POST, path: '/api/tickets/{id}/close' }
  target: { procedure: close-ticket }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: close-ticket-mcp }
spec:
  source: { kind: mcp, surface: admin }
  target: { procedure: close-ticket }
```

The target names a declared Procedure. `http` sources use POST/PUT/PATCH/DELETE and an `/api/` path. Path parameters bind to corresponding declared input fields and override JSON-body values. The generated REST module retains the Procedure's authorization and validates boundary input.

A path parameter is a whole `{name}` segment. Other segments are literal and may not start with `:` or contain braces, since [describe](describe.md) writes `{name}` as `:name` (`TRIGGER_PATH_INVALID`). Two Triggers with the same method and the same path apart from parameter names are refused (`TRIGGER_PATH_COLLISION`).

### Route precedence

When several http Triggers with the same method match a request, the generated router picks the most specific one, independent of manifest order:

1. fewer `{name}` parameters first;
2. then, comparing segments from the left, a literal segment before a parameter;
3. then the path text.

So `POST /api/items/export` wins over `POST /api/items/{id}`, and for `/api/items/latest` the route `POST /api/items/{id}` wins over `POST /api/{kind}/latest`. A public View's `GET /api/views/<name>` route comes before every Trigger. Gateways resolve the same order from [`matchTarget`](describe.md#matching-a-request-to-its-target).

An MCP source is `{ kind: mcp, surface: public }` or admin. The selected MCP module exposes the Procedure as a snake-case tool with its description, [tool hints](procedure.md#mcp-tool-hints) and requires checks.

By default, pair every HTTP Trigger with an MCP Trigger so the same operation is reachable by the user's AI. `mantle generate` warns when a Procedure has HTTP exposure but no MCP exposure, suggesting `surface: admin` for an admin-only Procedure and `public` otherwise. Triggers still decide every Procedure surface: intentional asymmetric exposure is allowed and generation succeeds.

Lifecycle and schedule sources are rejected at generation with `GENERATE_UNSUPPORTED`, including disabled schedules. Use an app-owned handler or scheduler. For signed webhooks, verify the original raw Request in the app and call a generated Procedure with validated input; do not route it through a JSON boundary before signature verification.

## Input rules

The admin MCP tool below lists `reason` and `closed` without the rules, and its
description ends "'reason' is required when 'closed' is false."; a call with
`closed: false` and no `reason` fails with `INPUT_VALIDATION_FAILED` at
`procedures/set-ticket/input/reason` (the error path is
`procedures/<name>/input/<field>`). See [surface contracts](surface.md) for the
supported rules.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: set-ticket }
spec:
  description: Open or close a ticket.
  input:
    type: object
    required: [id, closed]
    properties: { id: { type: string }, closed: { type: boolean }, reason: { type: string, maxLength: 200 } }
    additionalProperties: false
    if: { properties: { closed: { const: false } }, required: [closed] }
    then: { required: [reason] }
  output: { type: object }
  handler: { sql: 'UPDATE tickets SET closed=input.closed WHERE id=input.id RETURNING id,closed' }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: set-ticket-mcp }
spec:
  source: { kind: mcp, surface: admin }
  target: { procedure: set-ticket }
```

See [surfaces](surface.md) for mounted paths, error mapping and origin checks.
