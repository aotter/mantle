# Manifest envelope

Every YAML document has `apiVersion: cms.mantle.aotter.net/v2`, `kind`, `metadata.name` and `spec`. Kinds are Schema, View, Procedure and Trigger. Pass explicit file paths to `mantle generate`; a file may contain several documents separated by `---`.

The grammar is closed. Unknown keys and invalid declarations fail generation. Names are unique per kind; Schema and field names cannot differ only by case. Quote non-identifier Schema names in SQL. `input` and `auth` are reserved.

Titles and descriptions accept a string or locale map, such as `{ en: Products, zh-TW: 商品 }`. Selected UI/MCP chooses the configured locale with fallback.

Author SQL in PostgreSQL syntax. Generation renders it for postgres or sqlite, including bound inputs and compiled row policy. SQL native columns use `id`, `version`, `created_at`, `updated_at`, `author_id`, plus `status` / `published_at` for publishing. Store uses storage names too. Manifest index declarations use authored field/native names (`createdAt`), which compile to storage names.

Use `input.<name>`, `auth.uid()`, `now()` and supported `mantle.*` functions. Only declared relations and allowed SQL constructs may be referenced. See [Schema](schema.md), [View](view.md), [Procedure](procedure.md), [Trigger](trigger.md) and [CLI](../start/project-and-cli.md).
