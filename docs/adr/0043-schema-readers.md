# ADR-0043: Schema readers replace `Store.select`

**Status:** Accepted for #1432. The PostgreSQL measurement is not recorded: it is a follow-up
(see Validation). Amends ADR-0030, ADR-0032, ADR-0034, ADR-0035 and ADR-0042; points ADR-0040
at its first execution-cost application.

**Date:** 2026-10-10

**Builds on:** ADR-0030, ADR-0032, ADR-0034, ADR-0035, ADR-0040 and ADR-0042.

## Context

`Store.select` builds a fresh `StoreJson` IR on every call (`core/store/createStore.ts`). Every
cache that would make a repeat read cheap is keyed by IR identity: `compileCached`, the paged
statement cache (`pagedCache`) and each executor's printed-SQL cache. A new IR per call means none
of them hits, so a warm read pays validation, policy rewrite, paging, printing and a double row
clone (`runView`'s clone, then `decodeRow`) on every call. #1430 and #1432 measured this at roughly
0.4 to 1.3 ms of Mantle CPU per call on node:sqlite, against a native statement that costs
microseconds.

The fix is not a cache in front of `select`: the shape of a read is the thing to key, and it is
already the shape a typed API can state. Each Schema gets a reader whose calls are walked once into
a shape key and the bind values; the compiled shape is kept.

## Decision

### 1. Per-Schema readers replace `Store.select`

`store.db.<schema>` and `ctx.db.<schema>` (`ctx.db === ctx.store.db`) expose three reads:

- `get(id, { columns? })`: one entry or `null`;
- `first(query?)`: the first entry of the query or `null`;
- `find(query?)`: `{ rows, nextCursor? }`.

A query is `{ where?, columns?, orderBy?, search? }`, and `find` adds `limit` and `cursor`.

- `where` is **AND only**: `{ column: value }` is equality, `{ column: null }` is `IS NULL`, and a
  comparison object takes `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `notIn` and `isNull`.
  `or`, `not`, subqueries, joins and aggregates are written as Views and read with `store.view`.
- One `orderBy` column, with `id` as the tiebreak; `limit` is 1 to 500 and defaults to 50.
- The cursor format is unchanged: an old `select` cursor continues a reader.
- `write`, `view`, `id` and `sweepExpired` are unchanged, and **writes keep the full `StoreWhere`
  grammar** (`and`/`or`/`not` and `in` subqueries).

**Transitional state.** `Store.select` is removed. Between PR A (this decision, the readers, the
memo, the generated types and the collision checks) and PR B (the removal and the migration of
Admin, tests, docs and examples), `select` stays callable and `@deprecated`, behaving exactly as it
did. Develop is releasable in either state: with only PR A merged nothing is removed; PR B carries
the `breaking-change`.

### 2. Naming

A reader's property is the lower-camel projection of the Schema's declared name, one name per
Schema: `organization_members` is `organizationMembers`, `ticket-events` is `ticketEvents`, `Posts`
is `posts`. A name with a non-ASCII character, or one whose projection is empty or not a valid
JavaScript identifier (`2fa`, `---`, a CJK name), is **not refused**: the Schema's plan key (its
name in lower case) is the property, reached by bracket access. Only a true collision (two Schemas
that project to one name; names that differ only by case are `SCHEMA_NAME_CASE_COLLISION` already)
and the reserved names `constructor`, `then`, `__proto__`, `prototype`, `toString`, `valueOf`,
`hasOwnProperty` (and the other `Object.prototype` members) are refused, with the new diagnostic
`SCHEMA_READER_NAME_COLLISION`. The graph validator (so `mantle generate` and `compilePlan`),
`verifyPlan` and runtime boot all refuse; `verifyPlan` emits a diagnostic carrying that code, not
`INPUT_VALIDATION_FAILED` with a prefix.

A currently valid app whose Schema names collide after projection (`a-b` and `a_b`) breaks on
upgrade; that is rare and stated here.

### 3. Rows are plain objects

- Native columns are non-null (`id`, `version`, `createdAt`, `updatedAt`, `status` on a publishing
  Schema); `authorId` is nullable.
- Every Schema field is `NonNullable<T> | null`: storage does not require a column, so a read may
  find it empty. The scope field is excluded. `columns` narrows the row with `Pick`.
- Wire values are unchanged. `NOT NULL` storage for required fields is out of scope.

### 4. Execution

- One walk over the query (`walkRead`) validates its structure, reads each caller property exactly
  once, and returns the **shape key**, the **bind values** and a normalised copy of the query. The
  converter consumes only that copy, so a getter or a proxy cannot make the key and the IR differ.
- On a miss the existing converter and `runView` build the shape once: a stable `Program`, a
  precomputed row decoder and the binds' types. Its (column, operator) tags and values are compared
  with the walk's before the shape is kept; a disagreement is `INTERNAL_ERROR` and nothing is kept.
- On a hit the call checks its values against the recorded types, binds, calls the driver once and
  decodes each row in one pass. No conversion, dialect check, policy rewrite or print runs, and the
  executor receives the identical IR, so its printed-SQL cache hits.
- `get(id)` runs the compiled statement without paging.
- The memo holds only compiled artifacts, is bounded (256 shapes per Store, FIFO eviction), has no
  TTL, and is shared by a Store, every `as()` and the per-request binding: the IR contains no
  caller, who the caller is reaches the statement only as binds, and the mode is part of the compile
  cache's key. A shape is stored only after its first successful run, so a read the dialect or the
  policy refuses is never kept.
- It is explicitly a **request-shape cache** like `pagedCache`. It does **not** satisfy the compile
  cache's "no request input grows it" invariant: the number of shapes is a function of the
  requests, which is why it is bounded. A column named in two cases (`Name`, `name`) is two shapes
  with one IR each; that costs a slot, not correctness.
- Shapes compile on first use. The plan format and its fingerprint are unchanged.
- `in` and `notIn` lists are padded to a power of two by repeating the last item, never past half
  the executor's bind limit (`padLen`), so lists of 5 to 8 share one statement.
- On a hit each value is checked by the same predicate and codec the converter uses, and the bind
  step encodes it again. That double encoding is a deliberate trade for a single value-checking
  rule: it is a few microseconds of the measured hot path.

### 5. Guarantees kept

Scope, TTL and `requires` apply exactly as they did to `select`. The mode is in the compile key.
Published-only applies to public Views only, so a handler's reader returns every status (drafts
too). Every value is checked on every call. Every refusal is `INPUT_VALIDATION_FAILED`, on a cold
and on a warm memo, and a refusal never stores a shape.

### 6. Admin

Admin moves to readers in PR B. Its list filters merge on the same column: an equal value is
merged, two different equalities are an unsatisfiable AND and return an empty page without a
database call (this changes an invalid `sort` next to contradictory filters from a 400 to an empty
page). The semantics and tests are written in PR B.

## Consequences

- **Breaking, in PR B:** `Store.select`, `StoreSelect` and the generated `select` overloads are
  removed; `mantle.ts` must be regenerated; there is **no codemod**. This withdraws ADR-0030's
  codemod promise (ADR-0032 already dropped the `mantle-update` bin).
- The generated `mantle.ts` gains `Rows` and `Db`, and `Handler` receives
  `HandlerContext<Env, CallerStore>`; Core's `HandlerContext` and `HandlerFn` take a store type
  parameter, so an untyped Core ctx stays assignable to the typed one.
- **Hot path.** Warm Mantle overhead per call (wall minus driver time) on node:sqlite, 20k rows,
  5,000 calls after 200 warm-up calls (see Validation), reads from 7 to 38 microseconds for a
  one-row read and about 150 to 180 microseconds for a 50-row page, against `select`'s 640 to
  1,080 microseconds.
- **Cold reads still pay one conversion per shape** (about 2 to 9 ms for the first call in a fresh
  process, dominated by first-time JIT and the one-time validate, policy and print). The second
  call with other values, and the first call of another `as()` caller, cost what a warm call does.
  Cold parity for reads is not delivered here: precompiling `get(id)` and indexed reads at generate
  time belongs to #1433 / ADR-0044.
- No parity with a native call is claimed beyond warm per-read Store CPU. Procedure output
  validation, authentication, `decodeView`, the wrapper SQL shape and the D1 default-order
  tiebreak are untouched, and Views (the dominant cold cost on real routes) are not on this path.
- Handlers read with `ctx.db`; guards keep `ctx.db` on their read-only Store.
- A fourth boot check (reader names) and one getter per Schema at Store creation are the only
  boot work.

## Alternatives

- **(d) Intern `select` shapes only.** The fallback: keep the `select` API and key a memo by its
  query shape. It keeps the untyped surface, the OR/NOT/subquery grammar and the per-call walk
  without giving typed rows or a smaller grammar.
- **(b) Precompile at generate time.** Deferred to #1433 / ADR-0044; this ADR's memo is the
  runtime half and works for a plan without it.
- **(c) Pre-printed SQL fragments per Schema.** More code per dialect for a smaller saving once the
  compiled shape is memoised.
- **A fluent builder or an active record.** More API and per-call allocation for no cache key.
- **Global static finders (`Items.find(...)`).** They hide the Store, and with it the caller.

## How to apply

1. Read with `ctx.db.<schema>.get | first | find` (typed through the generated `Db`) or
   `store.db`, and with `readerOf(store.db, name)` where only a name is held.
2. Write an OR, NOT, subquery or aggregate read as a View and read it with `store.view`.
3. Regenerate `mantle.ts` (`mantle generate`) to get `Rows` and `Db`.
4. Do not change a Schema name to avoid a reserved name; the diagnostic names both Schemas.

## Validation

- Parity: reader SQL and binds equal a fresh Store's on D1 and PostgreSQL, whichever caller or
  mode warmed the shape; a seeded property test checks that the walk's binds equal the converter's
  for shuffled, integer-keyed queries; every refusal is checked cold and warm and never grows the
  memo; the compliance suite runs the reader cases on every engine.
- Counters: after a shape's first call, `StoreJson.read` and `dialect.check` run zero times and the
  executor receives the identical IR.
- Measurement, `packages/mantle/spike/bench-readers.mjs`, Node 22 `node:sqlite`, 20,000 rows over
  20 owners, an index on `(owner, updated_at)`. Mantle overhead in microseconds (wall minus driver
  time), p50:

  | Shape | select warm | reader warm | native (driver only) | reader cold first | reader cold second |
  |---|---|---|---|---|---|
  | `get(id)` | 937 | 11 | 11 | 9,384 | 143 |
  | `first({ where })` | 886 | 38 | 17 | 3,317 | 278 |
  | `find` eq + gte, 50 rows | 1,021 | 152 | 360 | 2,984 | 505 |
  | `find` with an `in` of 7 | 640 | 28 | 272 | 2,530 | 273 |
  | `find` with `search` | 655 | 7 | 4 | 2,016 | 64 |
  | `find` page 2 by cursor | 1,076 | 181 | 347 | n/a | n/a |

  The cold columns are the p50 of 20 fresh processes; the first call from a different `as()`
  caller costs what the second does. Native is the same printed statement through `prepare().all()`;
  for the 50-row shapes the reader's decode work is larger than the driver's own row copy, so the
  two columns are not comparable beyond order of magnitude.
- **PostgreSQL is not measured.** `MANTLE_PG_URL` was not available when this was written. ADR-0040
  asks for measurement before accepting added runtime state; this is the follow-up, and the memo
  holds only compiled artifacts and is bounded in the meantime.

## Implementation status

PR A: ADR, readers, memo, generated `Rows` and `Db`, `ctx.db`, collision checks, reader tests and
the compliance cases; `Store.select` is `@deprecated` and unchanged. PR B: removal of `select` and
the migration of Admin, tests, docs and examples.
