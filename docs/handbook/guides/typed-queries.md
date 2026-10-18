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
    SELECT id, subject, ticketState AS "ticketState" FROM tickets
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

## Prefer Store-backed ref Procedures for simple writes

For a single-entity create or partial update, prefer a declared `ref` Procedure
whose handler awaits its caller-bound `ctx.store.collection(...).insert(...)`
or `.update(id, allowedPatch, { lock: expectedVersion })`. Keep the Procedure's
`requires` and generated validation at its invocation boundary: Store enforces
row policy, but does not substitute for operation authorization. Do not invoke
a handler directly from a route and accidentally bypass those checks.

Insert/update returns the actual written native row. Inside a transaction,
that result is provisional until the outer transaction commits; later failure
can still roll it back. Report committed success or emit external effects only
after that transaction succeeds. Return an explicit
allowlist of useful business fields, its backend `id` and returned `version`;
do not spread the entire row, echo the submitted version, calculate a new
version instead of reading the result, or add a generic receipt adapter. These
ref results are app-owned: declare their output schema and make any required
native-to-wire conversion explicit at the boundary.

Patch only permitted fields. Omitted fields remain unchanged; define whether
explicit null clears a nullable field or is invalid. Do not expand a partial
request into a full replacement with defaults for unseen fields. A stale lock
is a conflict; preserve intent and reconcile/review rather than silently
refreshing the lock and retrying.

Use SQL Procedures when conditions or related effects must commit together:
for example, creating an order while decrementing stock under a CHECK, a state
transition guarded by an atomic WHERE, or an additive restock upsert. A
pre-read in TypeScript followed by an unguarded write is not equivalent.
Store `batch` is atomic for known writes; a D1 batch step cannot consume a prior
step's returned ID. D1 has no interactive transaction callback, so retain the
supported SQL program or another existing native atomic boundary for that case.
The [MCP design audit](agent-workflow-acceptance.md) applies these choices before
implementation and separates them from independent end-user acceptance.

## Several rows that commit together

An order with any number of lines, a cart checkout or a bulk import must commit
every row or none. Pass the rows as one array input and write them in one SQL
Procedure that reads the array as a row source: `json_each(input.items)` on
SQLite and D1, `jsonb_array_elements(input.items) AS j(value)` on PostgreSQL.
The Procedure's statements commit together on every target, so a Schema
`checks` failure in any line refuses the whole call with `CONFLICT` and leaves
no reservation and no line behind. Bound the array with `maxItems`.
A statement cannot read an earlier statement's `RETURNING`, so rows that must
refer to each other share a key from the input: here the caller (or a `ref`
handler that then calls this Procedure) supplies `orderRef`.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: products }
spec:
  title: Products
  lifecycle: operational
  checks: ["reserved <= stock"]
  schema:
    type: object
    required: [name, stock, reserved]
    properties:
      name: { type: string }
      stock: { type: integer, minimum: 0 }
      reserved: { type: integer, minimum: 0 }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: order_lines }
spec:
  title: Order lines
  lifecycle: operational
  schema:
    type: object
    required: [orderRef, productId, qty]
    properties:
      orderRef: { type: string }
      productId: { type: string, x-mantle-ref: products }
      qty: { type: integer, minimum: 1 }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: place-order }
spec:
  description: Place an order of one or more lines; a line that would oversell refuses the whole order.
  requires: { auth: { all: [ctx.user] } }
  input:
    type: object
    additionalProperties: false
    required: [orderRef, items]
    properties:
      orderRef: { type: string }
      items:
        type: array
        minItems: 1
        maxItems: 50
        items:
          type: object
          additionalProperties: false
          required: [productId, qty]
          properties:
            productId: { type: string }
            qty: { type: integer, minimum: 1 }
  output: { type: object }
  handler:
    sql: |
      UPDATE products SET reserved = reserved + (SELECT SUM(j.value ->> 'qty') FROM json_each(input.items) j WHERE j.value ->> 'productId' = products.id)
        WHERE id IN (SELECT j.value ->> 'productId' FROM json_each(input.items) j);
      INSERT INTO order_lines (orderRef, productId, qty)
        SELECT input.orderRef, p.id, j.value ->> 'qty' FROM json_each(input.items) j JOIN products p ON p.id = j.value ->> 'productId'
        RETURNING id, productId AS "productId";
```

Repeated lines for one product add up in the `SUM`, so they are checked against
the same stock. On PostgreSQL `->>` returns text: write
`CAST(j.value ->> 'qty' AS int8)` there. SQLite and D1 refuse that integer cast
(`SQL_TYPE`, because SQLite truncates where PostgreSQL rounds), and their `->>`
already returns the JSON number. Both statements are set operations, so an
unknown product id is not an error: the join writes no line for it and reserves
nothing. The result lists the lines written; a caller that sent more lines than
came back named a product that does not exist, and should show that line to its
user rather than retry.

Do not split this into a Store write, then a SQL Procedure, then a compensating
delete: the rows are visible between the steps and a failure leaves cleanup to
the handler. A `ref` handler that needs the rows written together calls this
Procedure through `ctx.store.procedures`.
