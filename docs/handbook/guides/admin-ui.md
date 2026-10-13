# Customize Admin from manifests

Select `--admin` and mount [native Admin](native-admin.md) from `@aotter/mantle-admin`. The app serves its assets and owns authentication. UI and SDK are separate packages.

Schema `uiSchema` selects fields, widgets, list columns, enum tabs and child navigation. The compiler derives sortable fields from indexed required/non-null fields; it emits selected system/statistics indexes in initial DDL. Apply those indexes through an explicit migration on existing databases.

Admin Views provide custom read lists; their SELECT outputs, column lineage and `uiSchema.list` define display/search/filter metadata. Procedures and MCP admin Triggers define operations with declared authorization, input checks and optional row targets. A hidden button never authorizes an operation.

Generic publishing edits apply to drafts; publishing transitions retain their atomic guards and OCC. Read-only collections refuse generic edits while declared Procedures can still run. Ref operations receive the caller/transaction-bound Store.

Use [extensions](admin-extensions.md) for app-owned pages, actions, panels or field renderers. Keep exact conflict/uncertain-outcome handling in the shared UI controller.
