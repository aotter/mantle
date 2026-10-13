# Reads: Views, REST and MCP

A View declares one PostgreSQL-syntax SELECT over declared Schemas or reusable internal Views. Generation parses, checks and lowers it for postgres or sqlite, adds row policy, and emits a typed function. Requests bind values and execute SQL; they do not parse or compile manifests.

Use internal Views for joins, aggregates, OR and reusable reads. Simple handler id lookups and AND filters can use Store. See [query from TypeScript](../guides/typed-queries.md) for a complete example.

| Surface | Exposure when mounted |
| --- | --- |
| public | REST `/api/views/<name>` and public MCP |
| staff | Admin View API and staff MCP |
| internal | Generated operation only; no public route/tool |

Every generated invocation retains its `requires`. SQL row policy limits scope, TTL and publishing visibility at every relation. The app supplies a verified Caller.

Bare Views return native row arrays. Declared date/date-time columns are formatted by SQL; other values retain driver behavior. Proved pageable Views also get `paged/views/<encoded-name>.ts`, returning `{ rows, nextCursor? }`. Internal paging creates no exposure. Keyset paging requires generate-time order/cardinality proofs; it does not avoid the source scan for an aggregate. Inspect native EXPLAIN and indexes.

See the [View reference](../reference/view.md), [surface contracts](../reference/surface.md) and [native value contract](../guides/native-execution.md).
