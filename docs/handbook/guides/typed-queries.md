---
description: Choose Store for writes and simple lookups; declare internal Views for richer reads.
---
# Query from TypeScript

| Work | Data path |
| --- | --- |
| Writes | Store `insert` / `update` / `delete`, atomic `batch`, supported `transaction`, or declared Procedures |
| Id lookup or simple AND filter | Store `findById` / `find` / `first`, inside handlers or an existing application |
| Joins, aggregates, OR, reusable reads | Internal View: manifest SQL that is reviewable and typed |

Never write raw SQL to Mantle collections: it bypasses scope, TTL, publishing and system-column rules. The Store applies row rules but does not check a View's or Procedure's `requires`; authorize your handler before using it.

## Declare an internal View

Save this as `manifests/tickets.yaml`:

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: tickets }
spec:
  title: Tickets
  lifecycle: operational
  indexes: [[ticketState]]
  schema:
    type: object
    additionalProperties: false
    required: [subject, ticketState]
    properties:
      subject: { type: string }
      ticketState: { type: string, enum: [open, closed] }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: tickets-by-state }
spec:
  surface: internal
  input:
    type: object
    additionalProperties: false
    required: [ticketState]
    properties:
      ticketState: { type: string, enum: [open, closed] }
  sql: |
    SELECT id, subject, ticketState FROM tickets
    WHERE ticketState = input.ticketState
    ORDER BY id ASC
```

Generate with `mantle generate cloudflare-d1 generated manifests/tickets.yaml`.
An internal View has no public REST route or MCP tool. Its generated function still applies declared authorization and compiled row policy.

```ts
import { store } from './generated/generated.js';
import ticketsByState from './generated/views/tickets-by-state.js';
import type { Caller } from '@aotter/mantle/contracts';

export async function readTickets(db: Parameters<typeof store>[0], caller: Caller) {
  const tickets = store(db, caller).collection('tickets');
  const first = await tickets.first({ where: { ticketstate: 'open' } });
  const rows = await ticketsByState(db, caller, { ticketState: 'open' });
  return { first, rows };
}
```

The app supplies a verified Caller and its existing native handle. External input needs boundary validation. Store rows, filters and writes use storage names (`ticketstate`, `created_at`); View aliases use the SQL output names.

## Store reads and writes

`find` returns `{ rows, cursor }` (null cursor on the last page), with limits 1–500 and opaque keyset cursors. `where` combines fields with AND; `orderBy` selects a generated indexed column with `id` ties. Most order columns must be NOT NULL; publishing `published_at` supports nulls. For a proved pageable internal View, import `paged/views/<encoded-name>.ts` and call `(db, caller, input, { limit?, cursor? })`. Other internal Views retain their bare row-array function.

Store keeps `find({ search: 'text' })`, `first({ search: 'text' })` and `count(where?)`. Search matches exact id or declared searchable fields under the same row policy.

`count` scans every matching row. For large tables or frequently shown totals, use an internal View with indexed predicates or avoid exact totals; a View's aggregate still scans the matching rows.

Store search, Admin list search and Views using `mantle.search` share the same dialect search. SQLite/D1 use FTS5 trigram for queries of 3 or more characters, and LIKE for shorter queries. PostgreSQL uses ILIKE over the declared fields, which scans by default. A View does not make PostgreSQL search faster. For large PostgreSQL tables, the application's agent adds trigram indexes in a migration; ILIKE then uses them with no code change:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX articles_title_trgm ON articles USING gin (title gin_trgm_ops);
```

Index each searched field as needed and inspect EXPLAIN for the workload. Case folding follows the engine.

Writes are lazy and execute once when awaited. Insert/update return native rows; delete returns void. `update(id, set, { lock })` and `delete(id, { lock })` require the version the caller reviewed. A stale lock, excluded row or unique clash is `CONFLICT`. `batch` atomically executes unused Writes from one Store in input order; a step cannot use a prior result.

Interactive `transaction(async tx => …)` exists on bun:sqlite and PostgreSQL, with collections, Views and Procedures bound to the transaction. D1 supports batches only. PostgreSQL defaults to serializable, with an explicit isolation override; SQLite uses BEGIN IMMEDIATE. Use `tx` inside the callback, not the outer Store or handle. Nested transactions and `tx.batch` are refused; there is no automatic retry.

Ref handlers receive `{ caller, db, store }` bound to the same Caller and transaction. Implement the generated `Handlers` interface and pass it to `store(db, caller, { handlers })`. Direct Procedure modules expose SQL Procedures; ref Procedures are reached through the bound Store or selected surfaces.

See [native execution](native-execution.md) for values and write outcomes and [migrations](../concepts/runtime-and-adapters.md#schema-installation-and-migrations) before changing a Schema.
