---
description: Write a schema migration yourself from the diff of generated/schema.sql - the procedure, what each change needs on SQLite (D1, bun:sqlite) and PostgreSQL, data migrations and table rebuilds, and reference apply patterns that are application code.
---
# Schema migrations

The runtime never creates, alters or checks tables, and Mantle ships no migration command, apply helper or ledger
(ADR-lite #2108).
A new database gets the generated `schema.sql`. Every later change is a migration that you, the application's author or
its coding agent, write from the diff of `schema.sql` and apply with the application's own tooling, before the code that
needs it deploys.

## What `schema.sql` guarantees

- **The same input gives the same bytes.** The same manifests, options and `mantle generate` command write the same
  `schema.sql`: no version, path or time is in it. Key order inside a manifest and the order of a `required` list do not
  change it.
- **One statement per line**, a blank line between statements.
- **A fixed order:** for each Schema, its `CREATE TABLE`, its indexes, then on SQLite its search (FTS5) and geo (R*Tree)
  tables and its triggers, or on PostgreSQL its checks (`ALTER TABLE … ADD CONSTRAINT`); then publishing indexes, Admin
  indexes (`--admin`), auth tables (`--auth`), and site tables and seed rows (`--site`).
- **What decides that order is yours:** the order of the manifests on the command line (`manifests/*.yaml` is sorted by
  file name), of Schemas in a file, of fields (the column order), and of `indexes`, `uniqueIndexes` and `checks` entries.
  Index and check names are numbered by position (`_mantle_ix_notes_0`, `_mantle_chk_notes_1`), so **append** a new
  entry to its list: one inserted earlier renames every entry after it, which the diff shows as changed indexes.

So `git diff` between two generations shows every change in the DDL Mantle emits. A new Schema, index, check or search
adds lines; a new field changes its table's `CREATE TABLE` line (one line removed, one added) and adds nothing else
unless the field is a geo field.

## Write a migration

1. Start from a commit whose `generated/` matches what the databases run (`pnpm check` runs `generate --check`).
2. Change the manifests and run `pnpm generate`. Never edit `generated/` by hand.
3. Read the change: `git diff -- generated/schema.sql`, or `git diff <ref> -- generated/schema.sql` against the commit
   or release tag the databases were built from.
4. Write the migration by hand from that diff with the rules below. Copy each statement from the new `schema.sql` and
   drop `IF NOT EXISTS`: a migration runs once, and on a database that already has an object of that name it should
   fail, not keep a different object silently.
5. Rehearse it on a copy of real data, then compare the copy with a fresh database built from the new `schema.sql`: on
   SQLite `PRAGMA table_xinfo(<table>)` and `SELECT type, name, sql FROM sqlite_schema WHERE type IN ('index',
   'trigger')`; on PostgreSQL `information_schema.columns`, `pg_indexes` and `pg_constraint`. A column added with
   `ALTER TABLE` comes last where a fresh table may have it earlier; generated SQL names its columns, so that is fine.
6. Apply it with the application's tooling ([applying migrations](#applying-migrations)) before the new code deploys.

The examples below start from this Schema, with rows in it:

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  schema:
    type: object
    required: [label]
    properties:
      label: {type: string}
      rank: {type: integer}
```

## What each change needs

| Change | What the diff shows | SQLite (D1, bun:sqlite) | PostgreSQL |
| --- | --- | --- | --- |
| New Schema; `--admin`, `--auth` or `--site` turned on | Added statements only | Apply the added statements | The same |
| New optional field | Its table's `CREATE TABLE` line changed: a new column at the end | `ALTER TABLE … ADD COLUMN` with the column's definition | The same |
| New required field | A new `NOT NULL` column without a default | `ADD COLUMN … NOT NULL` fails when the table has rows. See [new required field](#a-new-required-field) | The same |
| Column with a constant default (only `status`, when publishing turns on; a declared `default` never becomes a DDL default) | A new `… NOT NULL DEFAULT 'draft'` column | `ADD COLUMN` with the default: existing rows get it | The same |
| New `UNIQUE` or `PRIMARY KEY` column, or a non-constant default (a Better Auth plugin's unique field) | A new column with that constraint | Not possible with `ADD COLUMN`: [rebuild the table](#rebuild-a-sqlite-table) | `ADD COLUMN` (a unique column of NULLs is valid) |
| New index | An added `CREATE INDEX` | Apply it | Apply it; writes to the table wait for the build ([PostgreSQL notes](#postgresql-notes)) |
| New unique index | An added `CREATE UNIQUE INDEX` | Fails on existing duplicates: [check first](#a-new-unique-index) | The same |
| New check | Two added `BEFORE INSERT/UPDATE` triggers | Apply them: a Mantle check on SQLite is a pair of triggers, not a table `CHECK`, so no rebuild. Rows already stored are not checked; updating one that violates it fails | An added `ALTER TABLE … ADD CONSTRAINT … CHECK`: fails if an existing row violates it ([PostgreSQL notes](#postgresql-notes)) |
| Search added to a Schema | An FTS5 table and three triggers | Apply them, then the `rebuild` statement that indexes existing rows ([example](#search-on-an-existing-schema)) | Nothing: search needs no DDL |
| Geo field | Two new columns; an R*Tree table and three triggers | `ADD COLUMN` for each, then the added statements. The new columns are NULL, so the tree starts empty and correct | `ADD COLUMN` for each |
| Publishing turned on | `status` and `published_at` columns, an index, and every required field now nullable | Not additive: the nullable change needs a [table rebuild](#rebuild-a-sqlite-table) | `ADD COLUMN` twice, `ALTER COLUMN … DROP NOT NULL` per required field, the index ([example](#publishing-turned-on)) |
| Seed rows (`_mantle_tz`, `--site` defaults) | Added insert-if-missing rows | Apply them; a row that exists keeps its value | The same |

### Examples

A new optional field, `body: {type: string}`:

```sql
-- sqlite: a new optional field
ALTER TABLE "notes" ADD COLUMN "body" TEXT;
```

```sql
-- postgres: a new optional field
ALTER TABLE "notes" ADD COLUMN "body" text COLLATE "C";
```

A new index, `indexes: [[rank, id]]`, and a new check, `checks: ["rank >= 0"]`:

```sql
-- sqlite, postgres: a new index
CREATE INDEX "_mantle_ix_notes_0" ON "notes" ("rank", "id");
```

```sql
-- sqlite: a new check
CREATE TRIGGER "_mantle_chk_notes_0_i" BEFORE INSERT ON "notes" WHEN NOT (new.rank >= 0) BEGIN SELECT RAISE(ABORT, 'MANTLE_CHECK notes: rank >= 0'); END;
CREATE TRIGGER "_mantle_chk_notes_0_u" BEFORE UPDATE ON "notes" WHEN NOT (new.rank >= 0) BEGIN SELECT RAISE(ABORT, 'MANTLE_CHECK notes: rank >= 0'); END;
```

```sql
-- postgres: a new check
ALTER TABLE "notes" ADD CONSTRAINT "_mantle_chk_notes_0" CHECK (rank >= 0);
```

On a large PostgreSQL table, add it without reading every row under the lock, then validate it separately:

```sql
-- postgres: a new check, validated separately
ALTER TABLE "notes" ADD CONSTRAINT "_mantle_chk_notes_0" CHECK (rank >= 0) NOT VALID;
ALTER TABLE "notes" VALIDATE CONSTRAINT "_mantle_chk_notes_0";
```

A geo field, `at: {type: object, format: geo}`:

```sql
-- sqlite: a geo field
ALTER TABLE "notes" ADD COLUMN "at_lat" REAL;
ALTER TABLE "notes" ADD COLUMN "at_lng" REAL;
CREATE VIRTUAL TABLE "_mantle_geo_notes_at" USING rtree(id, minLat, maxLat, minLng, maxLng);
CREATE TRIGGER "_mantle_geo_notes_at_i" AFTER INSERT ON "notes" WHEN new."at_lat" IS NOT NULL AND new."at_lng" IS NOT NULL BEGIN INSERT INTO "_mantle_geo_notes_at" VALUES (new._rid, new."at_lat", new."at_lat", new."at_lng", new."at_lng"); END;
CREATE TRIGGER "_mantle_geo_notes_at_d" AFTER DELETE ON "notes" BEGIN DELETE FROM "_mantle_geo_notes_at" WHERE id = old._rid; END;
CREATE TRIGGER "_mantle_geo_notes_at_u" AFTER UPDATE OF "at_lat", "at_lng" ON "notes" BEGIN DELETE FROM "_mantle_geo_notes_at" WHERE id = old._rid; INSERT INTO "_mantle_geo_notes_at" SELECT new._rid, new."at_lat", new."at_lat", new."at_lng", new."at_lng" WHERE new."at_lat" IS NOT NULL AND new."at_lng" IS NOT NULL; END;
```

```sql
-- postgres: a geo field
ALTER TABLE "notes" ADD COLUMN "at_lat" float8;
ALTER TABLE "notes" ADD COLUMN "at_lng" float8;
```

### A new unique index

`uniqueIndexes: [[label]]`. Find the rows that would break it first, and resolve them with the data's owner:

```sql
SELECT "label", count(*) FROM "notes" GROUP BY "label" HAVING count(*) > 1;
```

```sql
-- sqlite, postgres: a new unique index
CREATE UNIQUE INDEX "_mantle_uq_notes_0" ON "notes" ("label");
```

### Search on an existing Schema

`searchableFields: [label]` on SQLite. The triggers index rows written from now on; the last statement indexes the rows
already stored:

```sql
-- sqlite: search on an existing Schema
CREATE VIRTUAL TABLE "_mantle_fts_notes" USING fts5("label", content='notes', content_rowid='_rid', tokenize='trigram');
CREATE TRIGGER "_mantle_fts_notes_i" AFTER INSERT ON "notes" BEGIN INSERT INTO "_mantle_fts_notes" (rowid, "label") VALUES (new._rid, new."label"); END;
CREATE TRIGGER "_mantle_fts_notes_d" AFTER DELETE ON "notes" BEGIN INSERT INTO "_mantle_fts_notes" ("_mantle_fts_notes", rowid, "label") VALUES ('delete', old._rid, old."label"); END;
CREATE TRIGGER "_mantle_fts_notes_u" AFTER UPDATE OF "label" ON "notes" BEGIN INSERT INTO "_mantle_fts_notes" ("_mantle_fts_notes", rowid, "label") VALUES ('delete', old._rid, old."label"); INSERT INTO "_mantle_fts_notes" (rowid, "label") VALUES (new._rid, new."label"); END;
INSERT INTO "_mantle_fts_notes" ("_mantle_fts_notes") VALUES ('rebuild');
```

### A new required field

Rows already stored have no value for it, so it cannot arrive `NOT NULL` in one step. Add it optional, fill it, then
enforce it in one of two ways:

- **Keep the column nullable and add a check** `checks: ["body IS NOT NULL"]` next to the optional field. No rebuild on
  either dialect; generated input types keep the field optional, and the check refuses a write without it.

  ```sql
  -- sqlite: a new field every row must have, enforced by a check
  ALTER TABLE "notes" ADD COLUMN "body" TEXT;
  UPDATE "notes" SET "body" = '' WHERE "body" IS NULL; -- the value existing rows should have
  CREATE TRIGGER "_mantle_chk_notes_0_i" BEFORE INSERT ON "notes" WHEN NOT (new.body IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'MANTLE_CHECK notes: body IS NOT NULL'); END;
  CREATE TRIGGER "_mantle_chk_notes_0_u" BEFORE UPDATE ON "notes" WHEN NOT (new.body IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'MANTLE_CHECK notes: body IS NOT NULL'); END;
  ```

  ```sql
  -- postgres: a new field every row must have, enforced by a check
  ALTER TABLE "notes" ADD COLUMN "body" text COLLATE "C";
  UPDATE "notes" SET "body" = '' WHERE "body" IS NULL; -- the value existing rows should have
  ALTER TABLE "notes" ADD CONSTRAINT "_mantle_chk_notes_0" CHECK (body IS NOT NULL);
  ```

- **List it in `required`.** On PostgreSQL add it, fill it, then `SET NOT NULL` (it reads every row). On SQLite
  [rebuild the table](#rebuild-a-sqlite-table).

  ```sql
  -- postgres: a new required field
  ALTER TABLE "notes" ADD COLUMN "body" text COLLATE "C";
  UPDATE "notes" SET "body" = '' WHERE "body" IS NULL; -- the value existing rows should have
  ALTER TABLE "notes" ALTER COLUMN "body" SET NOT NULL;
  ```

A scope or user field added to an existing Schema is the same case: its column is `NOT NULL`, and only you know which
owner each existing row belongs to.

### Publishing turned on

`lifecycle: publishing` adds `status` (existing rows become drafts), `published_at` and an index, and makes every
required field nullable, since drafts may be incomplete. Rows that should stay public after the change are published
again through the generated `notes.publish` Procedure, which checks their required fields.

```sql
-- postgres: publishing turned on
ALTER TABLE "notes" ADD COLUMN "status" text COLLATE "C" NOT NULL DEFAULT 'draft';
ALTER TABLE "notes" ADD COLUMN "published_at" timestamptz;
ALTER TABLE "notes" ALTER COLUMN "label" DROP NOT NULL;
CREATE INDEX "_mantle_ix_notes_published" ON "notes" ("published_at", "id");
```

SQLite cannot drop `NOT NULL` in place, so the table is rebuilt (the steps are below):

```sql
-- sqlite: publishing turned on (a table rebuild)
CREATE TABLE "notes_new" (_rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, author_id TEXT, status TEXT NOT NULL DEFAULT 'draft', "published_at" INTEGER, "label" TEXT, "rank" INTEGER) STRICT;
INSERT INTO "notes_new" (_rid, id, version, created_at, updated_at, author_id, "label", "rank")
  SELECT _rid, id, version, created_at, updated_at, author_id, "label", "rank" FROM "notes";
DROP TABLE "notes";
ALTER TABLE "notes_new" RENAME TO "notes";
CREATE INDEX "_mantle_ix_notes_published" ON "notes" ("published_at", "id");
```

## Changes that are not additive

Mantle drops nothing, and these need a migration that moves data. Write it, rehearse it on a copy, and deploy code that
works with both the old and the new shape when old and new code overlap during a release.

| Change | What to do |
| --- | --- |
| Dropped Schema or field | Drop the table or column after no deployed code reads it, in a later release. Keep the data until then. |
| Renamed Schema or field | The diff shows a drop plus an add; only you know it is a rename. `ALTER TABLE … RENAME TO` or `RENAME COLUMN` keeps the data (both dialects), then recreate every index, trigger, check or search table whose definition names it, from the new `schema.sql`, and compare with a fresh database. |
| Changed type | A new column, a backfill that converts each value, code switched to the new column, the old one dropped later. On SQLite, or to keep the name, rebuild the table with the conversion in its `INSERT … SELECT`. |
| Optional made required | Backfill, then PostgreSQL `ALTER COLUMN … SET NOT NULL`; SQLite rebuild. |
| Required made optional | PostgreSQL `ALTER COLUMN … DROP NOT NULL`; SQLite rebuild. |
| Changed index | Drop the old index and create the new one (a name shift from an inserted entry is a changed index too). On PostgreSQL see the lock notes below. |
| Changed check | SQLite: drop and recreate its two triggers. PostgreSQL: `DROP CONSTRAINT`, then `ADD CONSTRAINT`. Existing rows that violate the new rule need fixing first on PostgreSQL. |
| Changed search fields | SQLite: drop the FTS5 table and its triggers, create the new ones, then `rebuild`. |

### Rebuild a SQLite table

SQLite's `ALTER TABLE` can add, rename and drop columns, nothing else. Any other change rebuilds the table, following
SQLite's own procedure ("Making Other Kinds Of Table Schema Changes" in its `ALTER TABLE` documentation), briefly:

1. If foreign keys are enforced and other tables reference this one (Better Auth's `user` is referenced by `session` and
   `account`; Mantle's Schema tables have no foreign keys), turn enforcement off first on bun:sqlite
   (`PRAGMA foreign_keys = OFF`, outside the transaction), or defer it on D1 (`PRAGMA defer_foreign_keys = true`).
2. Run the steps below in one transaction on bun:sqlite. D1 refuses `BEGIN` and `COMMIT` in the SQL it runs: leave them
   out of a D1 migration file.
3. Create the new table under a temporary name, from the new `CREATE TABLE` line.
4. Copy the rows with `INSERT INTO new (columns) SELECT columns FROM old`, naming every column and keeping `_rid`: search
   and geo tables key on it.
5. Drop the old table. Its indexes and triggers go with it.
6. Rename the new table to the old name.
7. Recreate every index and trigger the table has in the new `schema.sql`.
8. If the table has search, run its FTS5 `rebuild` statement.
9. Check foreign keys (`PRAGMA foreign_key_check`), commit, and turn enforcement back on.

## PostgreSQL notes

- Plain `CREATE INDEX`, as `schema.sql` writes it, takes a `SHARE` lock: writes to the table wait until the build ends.
  For a large table write `CREATE INDEX CONCURRENTLY` instead. It cannot run inside a transaction block, so it runs on
  its own, outside the migration's transaction, and a failed build leaves an `INVALID` index behind: drop it and run it
  again.
- `ADD CONSTRAINT … CHECK` reads every row under a lock that blocks writes, and fails if one row violates it. Split it
  into `NOT VALID` and `VALIDATE CONSTRAINT` ([example](#examples)).
- `ADD COLUMN` changes the result of Mantle's prepared `RETURNING *` writes on that table: see
  [PostgreSQL through Hyperdrive](../cloudflare/postgres-hyperdrive.md#how-mantle-sends-statements).
- Run migrations with the deployment credentials, which may run DDL, not the request role.

## Applying migrations

How and when migrations run belongs to the application and its host. The patterns below are **application code**, a
starting point to copy and adapt; Mantle does not ship them. They share four rules:

1. A migration is an id that sorts in apply order (its file name) and its SQL text, reviewed and committed.
2. A ledger table the application owns records each applied id with the SHA-256 of its text.
3. A known id whose text has a different hash is refused: an applied migration is never edited, only followed by a new
   one.
4. Pending migrations run in id order, each in the same transaction as its ledger row, under a lock, so two callers (two
   deploys, two requests opening the same lazily created database) apply each one once.

On bun:sqlite, pass `db.exec()` the migration text trimmed (`db.exec(sql.trim())`). On Bun 1.3.14 (not on 1.4.4),
`exec()` drops the error of the last statement when whitespace follows its semicolon, as a file's final newline
does, so a failed last statement (a unique index over duplicate rows) reports nothing.

### PostgreSQL

One transaction under a transaction-scoped advisory lock. `Postgres` is the handle generated code takes (Bun.SQL, or
postgres.js).

```ts
// src/migrate-postgres.ts
import type { Postgres } from "@aotter/mantle/contracts";

/** A reviewed migration: an id that sorts in apply order (its file name) and its SQL text. */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Application code: applies the pending migrations in id order and returns their ids. */
export async function migrate(db: Postgres, migrations: readonly Migration[]): Promise<string[]> {
  const hashed = await Promise.all(migrations.map(async m => ({ ...m, hash: await sha256(m.sql) })));
  return db.begin("isolation level read committed", async tx => {
    // held until COMMIT or ROLLBACK: a second caller waits here, then sees what the first applied
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext('app_migrations'))", []);
    await tx.unsafe(
      "CREATE TABLE IF NOT EXISTS app_migrations (id text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      [],
    );
    const rows: { id: string; sha256: string }[] = await tx.unsafe("SELECT id, sha256 FROM app_migrations", []);
    const applied = new Map(rows.map(row => [row.id, row.sha256]));
    const pending = [...hashed].sort((a, b) => (a.id < b.id ? -1 : 1)).filter(m => applied.get(m.id) !== m.hash);
    for (const m of pending) {
      if (applied.has(m.id)) throw new Error(`Migration ${m.id} was applied with different text; add a new migration.`);
      await tx.unsafe(m.sql, []);
      await tx.unsafe("INSERT INTO app_migrations (id, sha256) VALUES ($1, $2)", [m.id, m.hash]);
    }
    return pending.map(m => m.id);
  });
}
```

`tx.unsafe(m.sql, [])` sends a migration of several statements in one round trip (the simple protocol, which postgres.js
and Bun.SQL use when there are no values). Run it from the release pipeline before the new code deploys; for databases
the application creates lazily, when it opens a database, before its first query. A `CREATE INDEX CONCURRENTLY` cannot
go through it: run that on its own.

### D1

D1 has neither advisory locks nor interactive transactions. Use Wrangler's own migrations, whose ledger is the
`d1_migrations` table in each database:

```sh
pnpm exec wrangler d1 migrations create DB notes_body   # creates migrations/0002_notes_body.sql: write the statements in it
pnpm exec wrangler d1 migrations apply DB --local        # rehearse on a copy of the data
pnpm exec wrangler d1 migrations apply DB --remote       # before wrangler deploy
```

Wrangler applies each pending file once per database and records its name, not its text: keep applied files unchanged
(a CI check of their hashes against a committed list does it), and run one apply at a time per database, from one
pipeline, since nothing locks. For one D1 database per tenant, apply to each database from that pipeline.
