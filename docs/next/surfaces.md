# Generated surface deltas

The wire contracts remain [0.2 surfaces](../handbook/reference/surface.md)
and [ADR-0012](../adr/0012-views-as-public-rest.md), as amended by the shipped
handbook. Only the implementation and responsibility changes follow.

- The app mounts generated modules and passes `{ db, caller }`; `caller(request)`
  is the app's own `resolveCaller(...)` call. There is no generated `service.ts`,
  `withCaller` framework or Better Auth wrapper.
- REST retains public `GET /api/views/<name>` with declared query input plus
  `limit` and `cursor`, answering `{ rows, nextCursor? }`. HTTP Triggers retain
  their own method/path; JSON bodies and path parameters form the Procedure
  input and responses contain its result. Errors remain
  `{ error: { code, message, path } }` with the 0.2 status. Cookie sessions cannot
  mutate across origins.
- MCP retains public `POST /mcp`, staff `POST /mcp/staff`,
  `query_view_<name>` on the View's declared surface, and one tool per MCP
  Trigger. Its SDK loads only through a request-time dynamic import.
- HTTP/MCP Triggers declare exposure only. `mantle generate` refuses schedule
  and lifecycle Triggers; Cloud scheduling is a separate capability.
- Retained Admin features keep their 0.2 paths; #1477 decides the retained set.

The generated `validation/views/<name>.ts` and
`validation/procedures/<name>.ts` export `validate(unknown)`. View validators
also export `query(URLSearchParams)` returning `{ input, limit?, cursor? }`.
REST and MCP use the same generated checks, with no runtime schema interpreter.
Supported checks are types/unions and nullable, required/properties/additionalProperties,
arrays/items and length bounds, enum, local `$defs`/`$ref`, string length/pattern,
numeric bounds/`multipleOf`, and date/date-time. Integers must be safe; fractional
`multipleOf` uses a 1e-9 quotient tolerance. `const`, `oneOf`, `uniqueItems` and
object property-count bounds are refused, alongside other unsupported keywords
and formats. Defaults remain
annotations and are not inserted into request input.

Transport-facing `paged/views/<name>.ts` exports
`page(db, caller, input, { limit?, cursor? })`, answering `{ rows, nextCursor? }`.
Bare `views/<name>.ts` retains native row arrays and accepts app-validated input;
selecting neither boundary adds no validation or paging work to that query.
Authored SQL `LIMIT` caps each page, up to 500, rather than the whole cursor walk.
A pageable exposed View orders one indexed NOT NULL Schema column, then `id`
in the same direction (or simply `id`). Unsupported exposed ordering is refused
at generation. Internal bare Views can retain aggregates and other native SQL.
Single-row aggregate/scalar Views expose one page and reject a cursor.

Cursors reuse the Store's percent-encoded JSON keyset codec. Selected View
cursors include operation provenance; malformed, foreign and
null-key cursors fail with `INPUT_VALIDATION_FAILED`. They are opaque navigation
values, not credentials; authorization and row predicates run on every page.
