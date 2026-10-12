# Supported and refused declarations

This is the agent-facing scope of generated Mantle applications, following
[#1465](https://github.com/aotter/mantle/issues/1465) and [ADR-0045](../adr/0045-next-runtime-core.md).
There is no compatibility layer for Core APIs, imports, envelopes or cursors,
and no automatic data migration. Rebuild application integration and move data
explicitly; apply `schema.sql` directly only to a new database.

## Supported

| Feature | Availability / agent action |
| --- | --- |
| Closed v2 Schema/View/Procedure grammar, PostgreSQL SQL authoring | Generated for Bun SQLite, Bun PostgreSQL, Cloudflare D1 and Cloudflare PostgreSQL; dialect behavior stays native. |
| Operational Schemas, scope, TTL read visibility, indexes, checks, native SQL facilities | Generated initial DDL and compiled SQL policy; run migrations and TTL maintenance in application code. |
| Typed SQL Views and Procedures, auth predicates, OCC, atomic writes | Generated bare queries accept validated inputs and a verified Caller; date/date-time outputs are ISO strings, native errors stay internal. |
| Typed Store collections and internal Views/Procedures | Shared Store, AND-only filters, indexed non-null keyset ordering, atomic batches; interactive transactions on SQLite/PostgreSQL. |
| Better Auth integration and Workers builds | App owns `auth.ts` and `resolveCaller`; `mantle generate` emits native Wrangler build configuration. Keep heavy auth imports lazy. |
| View keyset pages, generated boundary validation and HTTP error mapping | Planned [#1470](https://github.com/aotter/mantle/issues/1470). |
| REST and `http` Trigger exposure; MCP and `mcp` Trigger exposure | Planned [#1471](https://github.com/aotter/mantle/issues/1471), [#1472](https://github.com/aotter/mantle/issues/1472); app mounts generated modules with `{ db, caller }`. |
| Dynamic `web.ts`, Admin UI, web skill/example | Planned [#1473](https://github.com/aotter/mantle/issues/1473), [#1477](https://github.com/aotter/mantle/issues/1477), [#1478](https://github.com/aotter/mantle/issues/1478). |
| Opt-in publishing lifecycle; `ref` Procedures and typed `Handlers` | Planned [#1474](https://github.com/aotter/mantle/issues/1474), [#1475](https://github.com/aotter/mantle/issues/1475); keep side effects in custom handlers. |
| Published package and release measurements | Planned [#1479](https://github.com/aotter/mantle/issues/1479), [#1480](https://github.com/aotter/mantle/issues/1480). |

Planned means unavailable until its implementation merges: generation currently
rejects Trigger exposure, ref handlers and publishing writes rather than omit behavior.
Use application-owned handlers or operational Schemas in the meantime.

## Refused

Each unsupported declaration produces `GENERATE_UNSUPPORTED`, its manifest path,
and the following hint. Invalid grammar/SQL retains the compiler's own diagnostic
codes and paths. Multiple declarations produce multiple diagnostics.

| Declaration | Do instead |
| --- | --- |
| `schedule` Triggers, including disabled ones | Wire `scheduled()` yourself. |
| `lifecycle` Triggers: before/after hooks, including targets using `ref` | Write a custom handler. |
| `requires.guard` on a View or Procedure | Write a custom handler that checks authorization before executing queries. |
| Schema `localized: true` | Manage locales in application-owned fields and handlers; localization returns in 0.2.x. |
| Schema `translates` | Manage relationships in application-owned fields and handlers; translations return in 0.2.x. |
| A View projecting a native `geo` value | Select the latitude and longitude columns explicitly. |
| Dynamic or repeated View output names | Give each SELECT output a unique explicit alias. |
| Declared date/date-time outputs without one SELECT item per output | Expand the SELECT list explicitly. |
| Input properties differing only in case | Rename input properties to be unique without regard to case. |
| PostgreSQL JSON/date/date-time parameters used without the declared cast | Wrap each occurrence in the concrete `CAST(... AS <type>)` shown by the diagnostic. |

Old service APIs (site/config/media/email), automatic migrations and boot-time
schema convergence are outside generation; the app owns them. They are not v2
manifest declarations. Store `or`/`not`/joins/subqueries belong in internal SQL
Views; unsupported ordering fails the generated TypeScript contract. See
[query responsibilities](contract.md#revised-query-responsibility-decision-2026-10-11)
and [size/startup gates](size-and-startup.md). Availability is not performance evidence.
