---
description: Schema field reference for Mantle 0.2.0 — the JSON Schema, field types and storage, indexes, checks, search, scope, TTL, lifecycle, localization and uiSchema.
---
# Schema

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders                      # required; a string or a locale map
  description: …                     # optional
  lifecycle: operational             # publishing (default) | operational
  scope: { owner: auth.uid() }       # optional
  ttl: { field: expiresAt, expireAfterSeconds: 0 }   # optional
  checks: ["qty > 0"]                # optional
  uniqueIndexes: [[owner, orderNumber]]
  indexes: [[owner], [orderStatus, createdAt]]
  searchableFields: [orderNumber]
  localized: false
  translates: { parent: …, on: … }   # optional, localized child only
  uiSchema: { … }                    # optional, Admin only
  schema:                            # required: JSON Schema of the row
    type: object
    required: [owner, orderNumber, qty, orderStatus]
    properties: { … }
```

Unknown keys are refused. A Schema compiles to one table named after
`metadata.name`.

## `schema`

A JSON Schema object for the row's fields. It is checked on every write, Admin
and `ctx.store` included. `required` fields must be present on an operational
insert and when a draft is published; a draft may be saved incomplete.

| Property | Stored as (`sqlite`) | Stored as (`postgres`) | Notes |
|---|---|---|---|
| `type: string` | `TEXT` | `text` | |
| `type: string, format: date-time` | integer microseconds | `timestamptz` | an ISO string on the wire; compare with `now()` and `interval` in SQL; see [Date-time values](#date-time-values) |
| `type: string, format: date` | integer days | `date` | `"2026-10-01"` on the wire |
| `type: integer` | `INTEGER` | `int8` | |
| `type: number` | `REAL` | `float8` | |
| `type: boolean` | integer 0/1 | `bool` | `true`/`false` on the wire |
| `type: object`, `type: array` | JSON | `jsonb` | read with `->>` in SQL, or `json_each` on D1 (PostgreSQL: `jsonb_array_elements_text(…) WITH ORDINALITY AS j(value, n)`) |
| `format: geo` | two `REAL` columns and an R*Tree | two `float8` columns | `{ lat, lng }`; query with `mantle.near` and `mantle.distance` |

### Date-time values

**On the wire.** A declared `date-time` field, `created_at` and `updated_at`
come back as UTC with exactly six fractional digits, such as
`2026-10-01T04:00:00.500000Z`, on both dialects. So does an output that reads
such a column unchanged (and `min`, `max` or `sum` of one column). A computed
output differs by dialect. On PostgreSQL, `now()`, `date_trunc` and casts are
typed by the database and come back in the same shape (`infinity` and BC dates
stay as PostgreSQL writes them). On D1 a computed expression has no declared
field to decode with, so a View that selects `date_trunc('week', t.at)` or
`now()` returns integer microseconds since 1970. Select the column itself when
you need the ISO string, or format the number in the application.

**Accepted input.** An ISO 8601 string with an explicit `Z` or `±hh`, `±hh:mm`
or `±hhmm` offset, seconds optional, 0 to 6 fractional digits, and `T` or a
space between date and time. A string without an offset is refused
(`SQL_TYPE`).

**Range.** A value is microseconds since 1970 and must be a safe integer
(within ±2^53 microseconds): from `1684-07-28T00:12:25.260Z` to
`2255-06-05T23:47:34.740Z`. A string or numeric bind outside it is refused. A
sentinel such as `0000-01-01T00:00:00Z` for an open lower bound is therefore
refused; use a bound inside the range, such as `1970-01-01T00:00:00Z`, or leave
the input NULL and write `input.from IS NULL OR t.at >= input.from`.

**Comparing strings.** Mantle's own outputs are fixed-width UTC, so two of them
compare correctly as strings. A JavaScript `toISOString()` value
(`…43.377Z`) is not equal to Mantle's `…43.377000Z`, and as a string it sorts
after it (`Z` is greater than `0`). Compare in SQL, or normalize both sides to
one format first. A `Date` keeps milliseconds only, so a round trip through
`Date` drops microseconds.

### Per-member calendar buckets

`date_trunc` and `extract` compute in one site time zone
(`d1Storage(db, { timeZone })`, `postgresStorage({ timeZone })`). On D1 each
call looks up the zone's offset table (`_mantle_tz`) twice per row. A View that
buckets by day or week therefore reads the site's calendar, not the member's,
and pays those lookups on every row.

When the calendar must be the member's, compute the bucket when the row is
written and store it. The application knows the member's time zone and passes
the bucket as a Procedure input:

```yaml
properties:
  localDate: { type: string, format: date }                              # stored as integer days
  localWeek: { type: string, pattern: "^[0-9]{4}-W[0-9]{2}$", maxLength: 8 }   # ISO week; sorts as text
```

Index it after the scope (`indexes: [[owner, localWeek]]`, or a rollup's
`uniqueIndexes: [[owner, localWeek, exerciseKey]]`) and `GROUP BY localWeek`:
no time-zone lookup runs. In one real benchmark such a View was about five
times faster, and each member gets their own calendar. A member who changes
time zone keeps the buckets already written; whether to rewrite them is a
product decision. For long ranges see
[Long aggregate ranges](./view.md#long-aggregate-ranges).

### Reserved entry columns

A field may not be named like a native column (`id`, `status`, `version`,
`createdAt`, `updatedAt`, `authorId`), nor `expectedVersion`, nor `locale` on
a non-localized Schema. Two fields may not differ only in case
(`FIELD_NAME_CASE_COLLISION`): SQL resolves names case-insensitively.

Property extensions:

| Keyword | Meaning |
|---|---|
| `x-mantle-ref: <schema>` or `{ schema, field }` | the value is another Schema's `id` (or the named single-field unique field). Admin relates and binds rows by it, either way; a required one folds the child under its parent. `MANTLE_REF_INVALID` when the target is not `id` or a unique field |
| `oneOf: [{ const, title }, …]` | a string field whose options each have a label (a string or a locale map): stored as text, checked like an `enum`, usable as `uiSchema.list.filterField`, and shown by its `title` in Admin |
| `x-mcp-hint` | a widget hint: `markdown`, `html`, `richtext`, `code`, `media`, `media-image`, `media-video`, `media-file`, `money-minor`, `timestamp-ms`, `idempotency-key` |
| `title`, `description` | a field's label and help, a string or a locale map |
| `readOnly: true` (at the root) | Admin's generic entry routes refuse writes; declared Procedures still write |

`x-mantle-bind` is refused in 0.2.0: use `scope`, or set the value with
`auth.uid()` or `now()` in the Procedure's SQL.

### JSON Schema limits

These hold for every JSON Schema Mantle checks: a Schema's `schema`, and View
and Procedure inputs and outputs.

| Limit | Diagnostic |
|---|---|
| at most 100 levels deep and 10,000 schema nodes; an `enum` of at most 1,000 values | `JSON_SCHEMA_LIMIT_EXCEEDED` |
| a `pattern` of at most 1,000 characters that compiles as a JavaScript regex | `INVALID_PATTERN` |
| no repeated group whose body repeats or alternates (`(a+)+`, `(a\|b)*`, `^[a-z0-9]+(-[a-z0-9]+)*$`) and no backreference | `INVALID_PATTERN` |
| a `pattern` costs at most branches × maxLength^e ≤ 10,000,000, and declares `maxLength` when e > 0 | `INVALID_PATTERN` |

A JavaScript regex backtracks, and the pattern runs on every caller's string,
so its work is bounded by the string's `maxLength`. The exponent e counts the
variable quantifiers (`*`, `+`, `?`, `{m,}`, `{m,n}`, outside `[...]`), plus
1 when the pattern does not start with `^`, because an unanchored pattern is
retried at every offset; branches multiplies the alternatives of every
alternation. `^[a-z0-9-]+$` (e = 1) allows any maxLength up to 10,000,000,
the email `^[^@]+@[^@]+$` (e = 2) up to 3162, `^(?:[a-f0-9]{40}|[a-f0-9]{64})$`
(e = 0, 2 branches) needs none. A string longer than its `maxLength` is
refused before its pattern runs. The message names the largest maxLength the
pattern allows; lower it, anchor the pattern with `^`, or use fewer variable
quantifiers or alternatives.

These checks catch the patterns that backtrack catastrophically by accident;
they are a guard, not a proof that every accepted pattern is fast. Fixed
counts (`{1000}`), lookarounds and arrays of patterned strings still cost
work the estimate leaves out, so keep patterns short and anchored, and a host
that runs plans it does not trust bounds CPU per request.

A slug is `{ type: string, maxLength: 120, pattern: "^[a-z0-9-]+$" }`. It
accepts leading, trailing and doubled hyphens; to refuse them on a Schema
field, add `checks: ["slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'"]`.

## `lifecycle`

`publishing` (the default) gives rows the `draft` → `published` → `archived`
workflow; only drafts are editable, and a public View sees published rows only.
`operational` rows are live on insert and edit in place. See
[Lifecycle and locales](../concepts/lifecycle-and-locales.md).

## Indexes

- `indexes`: ordered composite non-unique indexes over top-level scalar fields
  and native columns, spelled in camelCase here (`createdAt`, not
  `created_at`). `status` exists only on a `publishing` Schema.
- `uniqueIndexes`: composite unique indexes. On a scoped Schema every entry
  starts with the scope field. A write that breaks one is `CONFLICT` with
  `conflict.reason: unique`; an `ON CONFLICT (<columns>)` target names one.

Boot creates a missing index; a declared one whose columns changed is blocked
until you drop the old one ([Deploy and operate](../cloudflare/deploy-and-operate.md)).

## `checks`

Boolean SQL expressions over the row's own columns, enforced on every insert
and update by what storage convergence creates: triggers on SQLite, a `CHECK`
constraint added `NOT VALID` on PostgreSQL. Rows that predate a check are left
alone:

```yaml
checks: ["stock >= 0", "partySize IS NULL OR partySize BETWEEN 1 AND 20"]
```

Storage prints a check into the table as written, so it names only the
Schema's own columns, unqualified, and calls only the functions SQLite and
PostgreSQL spell alike, each on one argument: `lower`, `upper` and `length`
on text, `abs` on a number. No subqueries, casts, `auth.*` or `now()`; a rule
about the caller belongs in a Procedure's guard. Other type mismatches
(`name > 5` on a text field) are the database's to refuse when the app boots. A violation fails the whole write with
`INPUT_VALIDATION_FAILED` and the message `CHECK <schema>: <expression>`.

## `searchableFields`

Top-level string fields for full-text search. On SQLite, an FTS5 trigram
index kept in step by triggers: a query of three characters or more matches
substrings (Chinese included); a shorter one scans. On PostgreSQL, a
case-insensitive substring scan (`ILIKE`) over the fields. Used by `mantle.search(t, q)` in SQL,
`search` in `ctx.store.select`, and Admin's search box. `id` is always
searched by Store's `search`. Date and date-time fields are refused.

## `scope`

```yaml
scope: { owner: auth.uid() }
indexes: [[owner]]
```

Exactly one field, bound to `auth.uid()`. It must be a required string, lead
an index, and lead every `uniqueIndexes` entry. Every read and write of a user
caller is limited to its own rows, anonymous callers reach none, Store fills
the field on insert, and no write may set it. `runtime.store` and the system
caller are not scoped. See [Authorization](../concepts/authorization.md).

## `ttl`

`{ field, expireAfterSeconds }`: `field` is a top-level `date-time` field. A
row is invisible to every read and write from `field + expireAfterSeconds`;
`runtime.store.sweepExpired({ collection })` (or a schedule handler's
`ctx.store.sweepExpired`) removes expired rows; until then an expired row
still holds its unique keys. Not allowed on a translation Schema.

## `localized` and `translates`

`localized: true` declares a `locale` string field. `translates: { parent, on }`
makes the Schema the localized child of a non-localized parent, joined on a
field both declare; it needs at least one content field besides `on` and
`locale`. Store does not check `locale` against the site's locales in 0.2.0.

## `uiSchema`

Admin presentation only; it never changes validation or MCP.

| Key | Values |
|---|---|
| `fields.<name>.widget` | `textarea` (a string field), or `<extension>/<contribution>`: an Admin extension's `field.input/v1` control, for any field type |
| `fields.<name>.options` | with an extension widget only: an object checked against the contribution's `optionsSchema` |
| `list.primaryField` | a scalar data field shown first (operational Schemas) |
| `list.columns` | data fields and native columns, in order (operational Schemas) |
| `list.cells` | data field or native column -> `<extension>/<contribution>`, an Admin extension's `field.cell/v1` renderer |
| `panels` | up to 16 `<extension>/<contribution>` names: Admin extension `record.sidebar/v1` panels on the record page |
| `list.filterField` | a string enum field that leads an index: tabs per value (operational Schemas) |
| `nav.standalone` | `true`: also list a folded child in navigation |
| `nav.parentField` | which `x-mantle-ref` field filters it, when several could |

Other keys are refused (`SCHEMA_UI_INVALID`). A contribution name is checked for shape here; whether it exists, fits the key and accepts the `options` is checked when Admin starts ([Extend Admin](../guides/admin-extensions.md)).

## Diagnostics

`SCHEMA_INDEX_INVALID`, `SCHEMA_INDEX_FIELD_UNKNOWN`,
`UNIQUE_INDEX_FIELD_UNKNOWN`, `SCHEMA_SEARCH_INVALID`,
`SCHEMA_SEARCH_FIELD_UNKNOWN`, `SCHEMA_TTL_INVALID`, `SCHEMA_UI_INVALID`,
`SCHEMA_NAME_CASE_COLLISION`, `FIELD_NAME_CASE_COLLISION`,
`MANTLE_REF_INVALID`, the `TRANSLATES_*` codes, `JSON_SCHEMA_UNSUPPORTED`; at
boot `STORAGE_CHANGE_BLOCKED` and `STORAGE_TABLE_NOT_OWNED`. See
[Diagnostics](./diagnostics.md).
