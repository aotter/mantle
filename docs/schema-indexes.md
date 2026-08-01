# Schema indexes on D1

Mantle stores every authored Schema property inside the shared `entries.data`
JSON `TEXT` column. Declare `indexes` for measured, hot access paths that need
an ordered non-unique B-tree index. Use `uniqueIndexes` when the same ordered
fields are a data-integrity constraint.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: account-members }
spec:
  title: Account members
  lifecycle: none
  schema:
    type: object
    properties:
      userId:    { type: string }
      state:     { type: string }
      accountId: { type: string }
      email:     { type: [string, "null"] }
  indexes:
    - [userId, state, accountId]
    - [accountId, state, userId]
  uniqueIndexes:
    - [accountId, userId]
    - [accountId, email]
```

Each inner array is one index. Field order is significant. A one-field array
is valid; a bare string or the retired `indexedFields` spelling is not.
Invalid matrix shapes report `INVALID_MANIFEST_ENVELOPE`; invalid index
semantics report `SCHEMA_INDEX_INVALID`, and unknown fields report
`SCHEMA_INDEX_FIELD_UNKNOWN` (`uniqueIndexes` keeps its existing
`UNIQUE_INDEX_FIELD_UNKNOWN` code).

## Leftmost-prefix behavior

For `[userId, state, accountId]`, SQLite can use the index for:

```sql
WHERE userId = ?
WHERE userId = ? AND state = ?
WHERE userId = ? AND state = ? AND accountId = ?
```

It does not provide the same guarantee when the leftmost field is skipped:

```sql
WHERE state = ? AND accountId = ?
```

The second declaration, `[accountId, state, userId]`, supports the other hot
path and supplies the requested order without a temporary sort:

```sql
WHERE accountId = ? AND state = ?
ORDER BY userId
```

Do not declare every possible permutation. Each index consumes storage and
adds work to inserts and updates. Start from an observed query plan or hot
endpoint and declare only the access paths it needs.

## Supported fields

Indexed fields are exact, own, top-level keys of
`spec.schema.properties`. `a.b` means a literal top-level key named `a.b`; it
does not traverse `{ a: { b: ... } }`.

An index-bearing Schema name and every indexed field must match
`^[A-Za-z][A-Za-z0-9_.-]*$`.

The property must declare exactly one non-null scalar type. It may also allow
`null` with a type array or `nullable: true`.

| JSON Schema type | generated-column affinity |
|---|---|
| `string` | `TEXT` |
| `integer`, `boolean` | `INTEGER` |
| `number` | `REAL` |

Objects, arrays, enum-only properties, and mixed non-null unions are not
indexable. Reserved native View fields (`id`, `status`, `version`,
`createdAt`, `updatedAt`, `authorId`) also cannot be index declarations.

Missing and `null` leftmost values are omitted from the partial index. SQLite
UNIQUE semantics still allow more than one composite containing `NULL`.

## Core-compiled queries

Mantle creates collection-gated VIRTUAL generated columns during `bootInit`.
Core-compiled View projections, filters, and ordering automatically reference
a generated column when their field is declared by `indexes` or
`uniqueIndexes`; undeclared fields keep using `json_extract`.

D1 stores the original JSON as `TEXT`, not PostgreSQL JSONB. The generated
scalar columns and their B-tree indexes are the supported indexed-path
mechanism. Their physical identifiers are private, versioned, and encoded;
never copy one from `sqlite_schema` into site code.

## Site-owned Procedure SQL

Use the pure helper when a business query remains site-owned. It returns a
fully quoted reference for a declared field or `null` when that field has no
declared index. Pass a table alias for joins so the generated column is not
ambiguous.

```ts
import {
  schemaIndexedFieldSql,
  type SchemaManifest,
} from "@aotter/mantle/spec";
import { loadManifests } from "../mantle/manifests.js";

const accountMembers = loadManifests().find(
  (manifest): manifest is SchemaManifest =>
    manifest.kind === "Schema" && manifest.metadata.name === "account-members",
);
if (!accountMembers) throw new Error("account-members Schema is missing");

const userId = schemaIndexedFieldSql(accountMembers, "userId", "member");
const state = schemaIndexedFieldSql(accountMembers, "state", "member");
if (!userId || !state) {
  throw new Error("account-members actor lookup requires its declared index");
}

const rows = await env.DB.prepare(
  `SELECT member.id, member.data
     FROM entries AS member
    WHERE member.collection = ?
      AND ${userId} = ?
      AND ${state} = ?`,
)
  .bind("account-members", actorId, "active")
  .all();
```

The helper does not authorize the query or define its business response. The
site still owns actor resolution, account rules, aggregation, and output.

## Verify a plan

Prefer the shipped crowded-data harness for a manifest View:

```bash
pnpm exec mantle-harness indexes --require-public --format text
```

It applies Mantle's real canonical migrations and generated DDL, seeds skewed
rows, compiles and executes the real View SQL, then records
`EXPLAIN QUERY PLAN`. By default findings are advisory; use `--require-public`
or repeat `--require <view-name>` only for paths whose performance is part of
the contract. See [the performance harness](./performance-harness.md).

For site-owned SQL that cannot be represented by a View, inspect the real
database directly when adding or changing a hot path:

```sql
PRAGMA index_list("entries");
PRAGMA index_xinfo("<index returned above>");

EXPLAIN QUERY PLAN
SELECT id FROM entries
WHERE collection = 'account-members'
  AND "<reference emitted by Core>" = 'user-1';
```

The plan should contain `SEARCH entries USING INDEX ...`, and an indexed
filter/order path should not contain `USE TEMP B-TREE FOR ORDER BY`.

Existing databases upgrade by adding new affinity-correct VIRTUAL columns and
versioned indexes; populated `entries` rows do not need a rewrite. Unused
generated columns may remain because dropping them is not safe across every D1
version Mantle supports. Compatible alpha.59 unique indexes remain during a
rolling upgrade; ambiguous legacy flattened names and indexes removed from
manifests are reconciled away at boot.

References: [D1 JSON](https://developers.cloudflare.com/d1/sql-api/query-json/),
[D1 generated columns](https://developers.cloudflare.com/d1/reference/generated-columns/),
[D1 indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/),
[SQLite partial indexes](https://www.sqlite.org/partialindex.html).
