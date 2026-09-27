# ADR-0033: Schema storage converges to the plan; Mantle verifies, the author changes

**Status:** Proposed for 0.2.0 (#1188). Amends ADR-0024; replaces the reviewed-artifact workflow of #1080 and #1086.

**Date:** 2026-09-27

**Related:** ADR-0007, ADR-0024, ADR-0025, ADR-0032, #1011, #1080, #1086, #1150

## Context

Schema tables (ADR-0024) evolve through an operation history:

- every created table, added column and index is a ledger id (`schema-table-v2:table:…`, `…:column:…`, `…:index:…`) in `_mantle_migrations`;
- `_mantle_schema_tables` stores the projection Mantle *believes* each table has, and boot compares the plan against that record (`isAdditiveSchemaTableChange`), not against the database;
- managed hosts (ChatGPT Sites, Cloud) get append-only `drizzle/*.sql` files from `buildSqliteMigrationArtifact` (#1086), and a unique-index change needs a reviewed artifact (#1080);
- anything else destructive is refused, and ADR-0024 tells operators to rebuild the database.

This has three costs. Authors and their agents maintain migration files they did not write. The record can drift from the real database, and Mantle cannot see it: an index the author stopped declaring stays in place forever (#1011). And every change Mantle cannot classify has no supported path.

Better Auth's `getMigrations`, which mantle-auth already runs for its own tables, takes the other approach: it introspects the database, diffs it against the configured schema, applies additions only, never drops or alters, and stops with an explanation when it cannot proceed (`UnsafeMigrationError`, a conflicting index). ADR-0007 makes the author's agent the primary author; the change Mantle cannot make safely is exactly the change that agent should make.

## Decision

### 1. The database is the state; the plan is the target

For each Schema, the target is the plan's table: native columns, one column per scalar field, and the declared indexes. The actual state is read from the database (`sqlite_schema`, `PRAGMA table_info`, `PRAGMA index_list`, `PRAGMA index_info`), never from a Mantle record of past operations.

The diff classifies every difference:

| Class | Differences | Mantle |
|---|---|---|
| **Safe** | a missing Schema table; a missing field column (Schema columns are nullable, ADR-0030); a missing non-unique index; a missing unique index whose creation succeeds | applies it |
| **Blocked** | a unique index that fails on existing data; a column whose type affinity differs; an index with a declared name but other columns or uniqueness; an undeclared **unique** index (it still constrains writes); a missing native column | refuses, with `STORAGE_CHANGE_BLOCKED` |
| **Undeclared** | a column or non-unique index that exists but is not in the plan (a removed field, an abandoned index) | reports a warning (`STORAGE_UNDECLARED_COLUMN`, `STORAGE_UNDECLARED_INDEX`); never drops |

A renamed field is an undeclared old column plus a missing new one; the author copies the data. A unique index is not tested for duplicates in advance: `CREATE UNIQUE INDEX` is attempted, and a constraint failure turns it into a blocked change with the failing index named.

### 2. Mantle verifies; the author changes

A blocked diagnostic carries the actual state, the target and, as a hint only, SQL that would reach the target. Mantle never runs that SQL. The author's agent makes the change with whatever it needs (SQL through the host's own tool, a data-copy Procedure run as the system caller, a dedupe script), and Mantle checks the database again. Storage is ready when no blocked difference remains.

There are no Mantle-written migration files for Schema tables and no destructive step Mantle performs on its own.

### 3. Where the check runs

- **Runtime-managed hosts** (the Cloudflare Worker and Bun presets): boot compares the plan fingerprint with the one stored in `_mantle_boot_state`. When they match, nothing is read. When they differ, boot introspects, applies the safe changes in one batch, stores the new fingerprint, and refuses to serve while a blocked change remains.
- **Hosts whose native mechanism is migration files** (ChatGPT Sites' `migrations_dir`, Cloud): `mantle storage diff` reads the target database through the host's tool and writes the safe changes as one new file in that mechanism. The file is output of the diff, like `compileMigrations`, not a history the author keeps. Boot on those hosts only reads: it introspects when the fingerprint differs and refuses to serve until the host has applied the changes.
- `mantle storage diff` prints the three classes for any host and never writes to the database; `mantle generate --check` includes it.

### 4. What stays versioned

- `_mantle_*` system tables and Core's product tables (`site_config`, `media_assets`, `pending_media_uploads`) keep canonical migrations in `_mantle_migrations`. Their shapes change with Mantle releases and sometimes need data moves (#1150); they are Mantle's own work and never the author's.
- mantle-auth keeps Better Auth's `getMigrations` for its tables.
- `_mantle_schema_tables` stays as the ownership registry: it names the tables Mantle created for Schemas, so a Schema never adopts an unrelated table (ADR-0032 decision 11). Its `projection` column is no longer an authority.
- Existing `schema-table-v2:*` ledger rows are left in place and no longer written.

### 5. Scope

The SQLite family (D1, Bun, libSQL) implements introspection. The IndexedDB adapter keeps its own object-store versioning; `MemoryStoreExecutor` has no storage to evolve.

## Consequences

- Removed: `buildSqliteMigrationArtifact`, `renderSqliteManagedMigration`, `isAdditiveSchemaTableChange`, `coversSchemaTableProjection`, the append-only artifact and its `storage-fingerprint.json`, the #1080 reviewed-artifact contract, and the per-column ledger ids. `buildSqliteMigrationArtifact` and `isAdditiveSchemaTableChange` are public exports of `@aotter/mantle-runtime` 0.1.4, so their removal is a breaking change listed in the 0.2.0 release note; the rest shipped only in 0.1.5 alphas.
- #1011 is covered: undeclared indexes are visible on every diff.
- The Swolhalla unique-index case (#1080) becomes: create the new unique index, drop the old one, rerun the check. No new Schema, no abandoned table.
- **Cloud.** "Storage matches the plan" becomes a platform-verified fact (ADR-0032 decision 10), checked by introspection instead of by the list of scripts that ran. A tenant's agent cannot run SQL against a Cloud-owned database today, so Cloud keeps refusing blocked changes until aotter/mantle-home offers a channel for author-made changes; that is a mantle-home issue, not a Core blocker.
- Boot on a changed plan costs a few `PRAGMA` reads per Schema, once per fingerprint.
- ADR-0024's "operators rebuild the database" is replaced by decision 2. Its native-table layout, reserved names and ownership rules are unchanged.

## Alternatives

- **Keep the reviewed-artifact workflow** (#1080, #1086) and extend it case by case. Rejected: each new change kind needs its own artifact type and review path, and the files still drift from the database.
- **Let Mantle generate destructive migrations behind a flag.** Rejected: Mantle cannot know whether a removed field is a rename, a split or garbage, and a wrong guess loses data.
- **Diff against `_mantle_schema_tables` instead of the database.** Rejected: that is today's design, and it cannot see what the author or another tool changed.
- **Introspect on every boot.** Rejected: the fingerprint already says when the plan changed; cold starts should not pay for `PRAGMA` reads.

## How to apply

1. Build the introspection and diff in the Store storage layer (ADR-0032 decision 4), shared by boot and the CLI.
2. Port the ADR-0024 conformance cases to the three classes, and add: an undeclared index is reported and kept; a failed unique index is blocked and applies nothing; a blocked change resolved by hand passes the next check; an unchanged fingerprint reads nothing.
3. Remove the artifact workflow in the same change that ships `mantle storage diff`, so there is never a release with neither.

## Implementation status

Proposed.
