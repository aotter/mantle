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

| Property | Stored as | Notes |
|---|---|---|
| `type: string` | `TEXT` | |
| `type: string, format: date-time` | integer microseconds | an ISO string on the wire; compare with `now()` and `interval` in SQL |
| `type: string, format: date` | integer days | `"2026-10-01"` on the wire |
| `type: integer` | `INTEGER` | |
| `type: number` | `REAL` | |
| `type: boolean` | integer 0/1 | `true`/`false` on the wire |
| `type: object`, `type: array` | JSON | read with `->>` or `json_each` in SQL |
| `format: geo` | two `REAL` columns and an R*Tree | `{ lat, lng }`; query with `mantle.near` and `mantle.distance` |

A field may not be named like a native column (`id`, `status`, `version`,
`createdAt`, `updatedAt`, `authorId`), nor `expectedVersion`, nor `locale` on
a non-localized Schema. Two fields may not differ only in case
(`FIELD_NAME_CASE_COLLISION`): SQL resolves names case-insensitively.

Property extensions:

| Keyword | Meaning |
|---|---|
| `x-mantle-ref: <schema>` or `{ schema, field }` | the value is another Schema's `id` (or the named single-field unique field). Admin relates and binds rows by it, either way; a required one folds the child under its parent. `MANTLE_REF_INVALID` when the target is not `id` or a unique field |
| `oneOf: [{ const, title }, …]` | a string field whose options each have a label (a string or a locale map): stored as text, checked like an `enum`, usable as `uiSchema.list.filterField`, and shown by its `title` in Admin |
| `x-mcp-hint` | a widget hint: `markdown`, `html`, `richtext`, `code`, `media`, `media-image`, `media-video`, `media-file`, `money-minor`, `idempotency-key` |
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
  `created_at`).
- `uniqueIndexes`: composite unique indexes. On a scoped Schema every entry
  starts with the scope field. A write that breaks one is `CONFLICT` with
  `conflict.reason: unique`; an `ON CONFLICT (<columns>)` target names one.

Boot creates a missing index; a declared one whose columns changed is blocked
until you drop the old one ([Deploy and operate](../cloudflare/deploy-and-operate.md)).

## `checks`

Boolean SQL expressions over the row's own columns, enforced on every insert
and update by triggers that storage convergence creates:

```yaml
checks: ["stock >= 0", "partySize IS NULL OR partySize BETWEEN 1 AND 20"]
```

No subqueries. A violation fails the whole write with
`INPUT_VALIDATION_FAILED` and the message `CHECK <schema>: <expression>`.

## `searchableFields`

Top-level string fields for full-text search: an FTS5 trigram index kept in
step by triggers. A query of three characters or more matches substrings
(Chinese included); a shorter one scans. Used by `mantle.search(t, q)` in SQL,
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
| `fields.<name>.widget` | `textarea` |
| `list.primaryField` | a scalar data field shown first (operational Schemas) |
| `list.columns` | data fields and native columns, in order (operational Schemas) |
| `list.filterField` | a string enum field that leads an index: tabs per value (operational Schemas) |
| `nav.standalone` | `true`: also list a folded child in navigation |
| `nav.parentField` | which `x-mantle-ref` field filters it, when several could |

Other keys are refused (`SCHEMA_UI_INVALID`).

## Diagnostics

`SCHEMA_INDEX_INVALID`, `SCHEMA_INDEX_FIELD_UNKNOWN`,
`UNIQUE_INDEX_FIELD_UNKNOWN`, `SCHEMA_SEARCH_INVALID`,
`SCHEMA_SEARCH_FIELD_UNKNOWN`, `SCHEMA_TTL_INVALID`, `SCHEMA_UI_INVALID`,
`SCHEMA_NAME_CASE_COLLISION`, `FIELD_NAME_CASE_COLLISION`,
`MANTLE_REF_INVALID`, the `TRANSLATES_*` codes, `JSON_SCHEMA_UNSUPPORTED`; at
boot `STORAGE_CHANGE_BLOCKED` and `STORAGE_TABLE_NOT_OWNED`. See
[Diagnostics](./diagnostics.md).
