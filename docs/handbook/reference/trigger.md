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
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: ticket-detail }
spec:
  surface: public
  requires: { auth: { all: [ctx.admin] } }
  input: { type: object, required: [id], properties: { id: { type: string } } }
  sql: 'SELECT id, closed FROM tickets WHERE id = input.id ORDER BY id'
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: ticket-detail-get }
spec:
  source: { kind: http, method: GET, path: '/api/tickets/{id}' }
  target: { view: ticket-detail }
```

`spec.target` names exactly one of a declared Procedure (`procedure`) or a public View (`view`, see [GET Triggers for a View](#get-triggers-for-a-view)). For a Procedure, `http` sources use POST/PUT/PATCH/DELETE and an `/api/` path. Path parameters bind to corresponding declared input fields and override JSON-body values. The generated REST module retains the Procedure's authorization and validates boundary input.

A path parameter is a whole `{name}` segment. Other segments are literal and may not start with `:` or contain braces, since [describe](describe.md) writes `{name}` as `:name` (`TRIGGER_PATH_INVALID`). Two Triggers with the same method and the same path apart from parameter names are refused (`TRIGGER_PATH_COLLISION`).

### Route precedence

When several http Triggers with the same method match a request, the generated router picks the most specific one, independent of manifest order:

1. fewer `{name}` parameters first;
2. then, comparing segments from the left, a literal segment before a parameter;
3. then the path text.

So `POST /api/items/export` wins over `POST /api/items/{id}`, and for `/api/items/latest` the route `POST /api/items/{id}` wins over `POST /api/{kind}/latest`; likewise `GET /api/orders/latest` wins over `GET /api/orders/{id}`. A public View's `GET /api/views/<name>` route comes before every Trigger, and no GET Trigger can match a path under `/api/views/`. Gateways resolve the same order from [`matchTarget`](describe.md#matching-a-request-to-its-target).

### GET Triggers for a View

A Trigger with `target: { view: <name> }` gives a public View a second, resource-shaped route, such as `GET /api/tickets/{id}` above, beside its generated `GET /api/views/<name>` (ADR-0047). It reuses the View's generated input reader, paging, `requires`, scope and `restrict`, and answers `{ rows, nextCursor? }` like the View route.

- The source is `{ kind: http, method: GET }`; any other method or an `mcp` source is `INVALID_MANIFEST_ENVELOPE` at `/spec/source`. A View's MCP exposure still comes from its `surface`. Declaring both `procedure` and `view` is `INVALID_MANIFEST_ENVELOPE` at `/spec/target`.
- The View has `surface: public`. An unknown View is `TRIGGER_TARGET_VIEW_UNKNOWN`; an `admin` or `internal` one is `TRIGGER_TARGET_VIEW_SURFACE`.
- The first segment after `/api/` is a literal other than `views` and `auth`, which Core keeps for generated View routes and Better Auth's default base (`TRIGGER_PATH_RESERVED`). A custom Better Auth `basePath` is not reserved; keep it clear yourself.
- The path has no empty, `.` or `..` segment, no `%` and no trailing `/` (`TRIGGER_PATH_INVALID`).
- Each `{name}` names a top-level input property of type `string`, `integer`, `number` or `boolean` (`null` allowed), at most once (`TRIGGER_PATH_PARAM_INVALID`). Inputs named `limit` or `cursor` stay refused (`VIEW_INPUT_RESERVED_NAME`).

The route is strict where `/api/views/<name>` is lenient. Each of these is 400 `INPUT_VALIDATION_FAILED`, in this order, and none reads data: a path parameter also given in the query string; a query key given twice; a value the View's input rejects (the same messages as the View route); a query key that is neither `limit`, `cursor` nor a declared input; then, as on the View route, `limit` below 1 and a malformed or foreign cursor. Path values are percent-decoded and coerced to their declared type. Paging is the View's: `limit` defaults to `min(50, cap)` and a larger value is clamped, an empty `cursor` is ignored, and a cursor from one of the View's two routes works on the other. The route answers GET only: `HEAD` is 405 with `Allow: GET`.

[Describe](describe.md) lists the Trigger under the View's `triggers` and adds a `rest:GET /api/tickets/:id` target whose variant is `view:ticket-detail`, so gateways pin it like any other route.

An MCP source is `{ kind: mcp, surface: public }` or admin. The selected MCP module exposes the Procedure as a snake-case tool with its description, [tool hints](procedure.md#mcp-tool-hints) and requires checks.

By default, pair every HTTP Trigger with an MCP Trigger so the same operation is reachable by the user's AI. `mantle generate` warns when a Procedure has HTTP exposure but no MCP exposure, suggesting `surface: admin` for an admin-only Procedure and `public` otherwise. Triggers still decide every Procedure surface: intentional asymmetric exposure is allowed and generation succeeds.

A source is `http` or `mcp`. A `schedule` or `lifecycle` source fails validation with `INVALID_MANIFEST_ENVELOPE` at `/spec/source/kind`: wire `scheduled()` yourself ([scheduled work](../cloudflare/deploy-and-operate.md#scheduled-work); ADR-lite #2111), or write a custom handler. For signed webhooks, verify the original raw Request in the app and call a generated Procedure with validated input; do not route it through a JSON boundary before signature verification.


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
