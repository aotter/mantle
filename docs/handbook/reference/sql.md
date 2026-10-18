---
description: The SQL that Views and Procedures accept on SQLite/D1 and on PostgreSQL, and what each refuses with which diagnostic.
---
# SQL accepted by each dialect

Views and Procedures share one allowlist with two profiles. SQLite and D1 run the base profile; PostgreSQL runs the
base profile plus the additions below. Anything not listed is refused at generation with a code (`SQL_UNSUPPORTED`,
`SQL_FUNCTION`, `SQL_SHAPE`, `SQL_TYPE`) and a source position, so generation is the authority for each target. For
worked examples see [SQL patterns](../guides/sql-patterns.md).

## Both dialects

| Area | Accepted |
| --- | --- |
| Statements | `SELECT`, `INSERT … VALUES` / `INSERT … SELECT`, `UPDATE … SET … WHERE`, `DELETE … WHERE`, each with `RETURNING`; `WITH` (non-recursive) on a `SELECT` |
| Upsert | `ON CONFLICT (<unique index columns>) DO NOTHING` / `DO UPDATE SET …`, with `excluded.<column>` |
| Joins | `INNER JOIN`, `LEFT JOIN`; a comma join only for a row source (`json_each`, or PostgreSQL's below) |
| Clauses | `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT` |
| Predicates | `=`, `<>`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`, `IS [NOT] NULL`, `IS [NOT] DISTINCT FROM`, `[NOT] BETWEEN`, `IN (list)`, `IN (subquery)`, `LIKE`, `[NOT] EXISTS (subquery)` |
| Expressions | `+ - * / %`, `\|\|`, `->>` (JSON field), `CASE`, `COALESCE`, `NULLIF`, scalar subqueries, `CAST(… AS text \| int4 \| int8 \| float8 \| bool \| timestamptz \| date \| numeric \| interval)` |
| Aggregates | `count`, `sum`, `min`, `max`, `avg` |
| Windows | `row_number()`, `rank()`, `sum()`, `count()` with `OVER (PARTITION BY … ORDER BY …)` and the default frame |
| Scalar functions | `lower`, `upper`, `length`, `abs`, `round`, `substr`, `replace`, `trim`, `ltrim`, `rtrim`, `instr` |
| Time | `now()`, `date_trunc('hour' \| 'day' \| 'week' \| 'month' \| 'year', …)`, `extract(year \| month \| day \| dow \| hour FROM …)` |
| Mantle | `auth.uid()`, `input.<name>`, `mantle.search`, `mantle.search_rank`, `mantle.near`, `mantle.distance` ([features](features.md)) |

## SQLite and D1 only

| Accepted | PostgreSQL instead |
| --- | --- |
| `json_each(<array>)` as a row source (`FROM json_each(input.items) j`, `j.value ->> 'field'`) | `jsonb_array_elements(…) AS j(value)` |
| `json_group_array`, `json_group_object` | `jsonb_agg`, `jsonb_object_agg` |
| `json_extract`, `json_set`, `json_insert`, `json_remove`, `json_array_length`; build an object with `json_set('{}', '$.k', v, …)` (`json_object` is refused) | `jsonb_build_object`, `jsonb_build_array` and the jsonb operators |
| `typeof`, `hex` | refused (`typeof` is SQLite's; PostgreSQL has `pg_typeof`) |

An integer `CAST` of anything but a literal is refused (`SQL_TYPE`): SQLite truncates where PostgreSQL rounds. Write
`round(x)`; `->>` already returns a JSON number as a number.

## PostgreSQL additions

| Area | Accepted |
| --- | --- |
| Set operations | `UNION [ALL]`, `INTERSECT`, `EXCEPT`, inside a `WITH` or a subquery (the View's own SELECT is the one that pages) |
| Relations | `LATERAL` subqueries, `WITH RECURSIVE`, `MATERIALIZED` / `NOT MATERIALIZED` CTEs |
| Row sources | `jsonb_array_elements`, `jsonb_array_elements_text`, `jsonb_each`, `jsonb_each_text`, with `WITH ORDINALITY` |
| Operators | `ILIKE`, `~`, `~*`, `!~`, `!~*`, jsonb `->`, `#>`, `#>>`, `@>`, `<@`, `?`, `?\|`, `?&` |
| Aggregates | `string_agg`, `jsonb_agg`, `jsonb_object_agg`, with `FILTER (WHERE …)` and `ORDER BY` inside the call |
| Windows | also `avg`, `min`, `max`, `lag`, `lead`, `first_value`, `last_value`, `dense_rank`; frames except `GROUPS` and `EXCLUDE` |
| Functions | `GREATEST`, `LEAST`, `floor`, `ceil`, `sqrt`, `power`, `split_part`, `timezone`, `jsonb_build_object`, `jsonb_build_array`, `jsonb_strip_nulls`, `to_jsonb`, `jsonb_typeof`, `CAST(… AS jsonb)` |
| Time | `date_trunc` also `'minute'`, `'quarter'`; `extract` also `minute`, `quarter`, `week`, `isoyear`, `isodow`, `doy`, `epoch` |

`jsonb_agg` of no rows is `NULL`: write `COALESCE(jsonb_agg(…), CAST('[]' AS jsonb))` for an empty array.

## Refused on every target

- `OFFSET`: page with the generated cursor (`limit`, `cursor`) instead.
- `RIGHT` and `FULL` joins, `UPDATE … FROM`, `DELETE … USING`, DDL and any function not listed.
- `DISTINCT` with `ORDER BY`: the paging key Mantle appends would change what is distinct; use `GROUP BY`.
- A program of more than 2000 syntax nodes.

Two write rules come from Mantle, not the dialect ([Procedure](procedure.md)). A row-classified `UPDATE`/`DELETE`
(`WHERE id = input.id …`) must change exactly one row, otherwise `CONFLICT`. A set form (`WHERE id IN (SELECT …)`,
`INSERT … SELECT`) may change none, so write a conditional write that may do nothing in that form. Scope, version,
timestamps and author columns are assigned by Mantle, never by your SQL.
