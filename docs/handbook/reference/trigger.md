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
  requires: { auth: { all: [{ ctx.admin: [admin] }] } }
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
```

The target names a declared Procedure. `http` sources use POST/PUT/PATCH/DELETE and an `/api/` path. Path parameters bind to corresponding declared input fields and override JSON-body values. The generated REST module retains the Procedure's authorization and validates boundary input.

An MCP source is `{ kind: mcp, surface: public }` or admin. The selected MCP module exposes the Procedure as a snake-case tool with its declared description/annotations and requires checks.

Lifecycle and schedule sources are rejected at generation with `GENERATE_UNSUPPORTED`, including disabled schedules. Use an app-owned handler or scheduler. For signed webhooks, verify the original raw Request in the app and call a generated Procedure with validated input; do not route it through a JSON boundary before signature verification.

See [surfaces](surface.md) for mounted paths, error mapping and origin checks.
