---
description: The manifest envelope of Mantle 0.2.0 — apiVersion, kind, metadata, files and documents, names, localized text, and the SQL naming conventions every atom shares.
---
# Manifest envelope and conventions

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema            # Schema | View | Procedure | Trigger
metadata:
  name: orders          # required, unique per kind
spec: { … }             # kind-specific
```

- `apiVersion` is exactly `cms.mantle.aotter.net/v2`. A `v1` document fails
  and names the upgrade guide.
- `metadata` has `name` only.
- Unknown keys anywhere in `spec` are refused, not ignored.

## Files

`mantle generate` reads every `.yaml` and `.yml` file directly in the manifest
directory (`./manifests`, or `--manifests <dir>`), not subdirectories. A file
may hold several documents separated by `---`. File names and order do not
matter to the plan; they enter only `sourceHash`.

## Names

- Names are unique per kind (`DUPLICATE_NAME`). Two Schemas, or two fields of
  one Schema, may not differ only in case: SQL resolves identifiers
  case-insensitively.
- A Schema name that is not a plain identifier (`support-tickets`) is written
  quoted in SQL: `"support-tickets"`.
- `input` and `auth` are reserved and cannot name a Schema or an alias. A
  Schema or field may not be one of the 14 words SQLite refuses unquoted:
  `add alter autoincrement commit delete drop escape index insert nothing raise set transaction update`.
- MCP tool names are the View or Procedure name in snake case.

## Localized text

`title` and `description` on every atom, and `title` and `description` on
JSON Schema properties, take a string or a locale map:

```yaml
title: { en: Products, zh-TW: 商品 }
```

Admin chooses the viewer's locale and MCP the surface's `locale` option (default `en`), then `en`, then the first entry.

## SQL conventions

| | |
|---|---|
| Syntax | PostgreSQL, parsed by PostgreSQL 18's parser; a dialect decides what runs |
| Native columns | snake_case in SQL: `id`, `status`, `version`, `created_at`, `updated_at`, `author_id`. In `ctx.store` JSON, in `indexes` and in Schema `uiSchema`: `createdAt`, `updatedAt`, `authorId` |
| References | `input.<name>`, `auth.uid()`, `auth.role()`, `now()` |
| Mantle functions | `mantle.search`, `mantle.search_rank`, `mantle.near`, `mantle.distance` |
| Literals | SQL literals; strings in single quotes |
| Multi-line SQL | a YAML block scalar (`sql: \|`) |

## Wire values

| JSON Schema | On the wire |
|---|---|
| `format: date-time`, and the native `createdAt` / `updatedAt` | an ISO 8601 string |
| `format: date` | `YYYY-MM-DD` |
| `boolean` | `true` / `false` |
| `object`, `array` | JSON |

## Generated output

`plan.json` and `mantle.ts` under `.mantle/generated/` are rewritten by every
`mantle generate` and compared by `--check`. Commit them; never edit them. See
[Project layout and CLI](../start/project-and-cli.md).
