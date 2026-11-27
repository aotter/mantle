# ADR-lite: Schema migrations are application-owned

**Status:** Accepted, issue #2108. Core ships no migration tooling. Its opening is the generated `schema.sql`, which
stays deterministic and diffable, and a handbook guide gives the knowledge a migration's author needs. No command,
subpath, grammar, generated file or runtime change. The 2026-11-27 amendment adds one CLI warning; see
[Amendment](#amendment-2026-11-27-a-changed-schemasql-points-to-the-guide).

## Context

`mantle generate` writes `schema.sql` for an empty database. Every later change is a migration the application writes
and applies with its own tooling, because the runtime runs no DDL (CONTRIBUTING.md, hard invariants; ADR-0045; #1566).
In practice the application's coding agent regenerates, compares the old and new `schema.sql` and writes the SQL that
takes a database from one to the other.

#2108 asked Core to do more: draft that SQL with a command, and apply it with a helper and a ledger. Applications with
one database per tenant or per site do this for every release, cannot re-create their databases, and often cannot reach
them with the host's migration command (the application creates them lazily, on first use).

Two applications that already apply migrations to such databases do it with different, incompatible policies: one
records an id and a content hash, applied when it publishes, under a privileged role; the other records a digest chain,
applied lazily the first time a database is used. Neither policy is wrong for its host.

Prior decisions: Core once converged storage at boot and kept a `_mantle_migrations` ledger (ADR-0033, #1150). The
no-runtime-DDL rule removed both (#1566). ADR-0033's lasting idea stays: SQL Mantle shows for a schema change is "a hint
only … Mantle never runs that SQL".

## Decision

1. **Core ships no migration tooling:** no diff command, no apply helper, no ledger. The application (in practice its
   coding agent) writes each migration and applies it with its own tooling.
2. **Core's opening is `generated/schema.sql` itself.** For the same manifests, options and command it is the same
   bytes: it holds no version, path or time, and it does not depend on key order inside a manifest or on the order of a
   `required` list. It holds one statement per line, in a fixed order: each Schema's table, then its indexes, its SQLite
   search and geo tables and its triggers or PostgreSQL checks, in the order of the manifests and their entries; then
   publishing indexes, Admin indexes, auth tables, and site tables with their seed rows. So `git diff` between two
   generations shows every change in the DDL the generator emits: a new Schema, index, check or search adds lines; a
   new field changes its table's `CREATE TABLE` line. Index and check names are numbered by their position in the
   manifest's list, so appending keeps the diff local. `packages/mantle/tests/migrations-guide.test.ts` holds this.
3. **Core documents the knowledge a migration's author needs:**
   [schema migrations](../handbook/guides/migrations.md), written for a coding agent that has just changed a manifest
   and regenerated: the procedure, what each kind of change needs on SQLite (D1, bun:sqlite) and on PostgreSQL, the
   changes that need a data migration, and reference apply patterns that are the application's own code. The same test
   applies the guide's example statements to a database with rows on bun:sqlite and PostgreSQL and compares it with a
   fresh database built from the new `schema.sql`.
4. **Considered and declined:**
   - **A draft-only diff command** (`mantle migrations diff <old> <new>`, printing the additive DDL and refusing the
     rest). It was prototyped and worked, but it is not a minimal opening: it is a strict reader coupled to every DDL
     template of the generator (each template change must be mirrored in it), it carries a per-dialect rule table of
     what is additive in code, and it makes Core answerable for whether a migration is right. And it adds little: every
     name the generator emits (indexes, triggers, checks) is already in `schema.sql`, which `git diff` compares. What an
     author lacks is knowledge, which the guide gives.
   - **`applyMigrations()` and a ledger.** Ledger shape, locking and apply policy differ between applications (applied
     at publish under a privileged role with an id-and-hash ledger; applied lazily on first use with a digest chain),
     and the runtime runs no DDL. This is consistent with ADR-0033's "hint only … Mantle never runs that SQL" and with
     the no-runtime-DDL rule. The guide shows reference patterns as application code.
5. **What would reopen it:** evidence from more than one application, filed as extension point requests with the
   workaround marked `drop when aotter/mantle#N`, that authors (human or agent) keep getting a specific class of
   migration wrong despite the guide. The answer would then be the smallest tool that addresses that class, not a
   migration system.

## Consequences

- No new command or generated file: `generate --check` and existing applications see no change. Since the 2026-11-27
  amendment, `generate` prints one warning when it rewrites an existing `schema.sql`.
- The generator's DDL templates stay free to change; a change shows up in an application's `schema.sql` diff and in its
  release notes, and the guide's test fails when a documented statement no longer reproduces a fresh database.
- Applications keep their ledger and apply policy, and their coding agent writes each migration from the diff.

## Amendment 2026-11-27: a changed `schema.sql` points to the guide

The guide reaches an author only if the author goes looking for it. In a blind test, a coding agent asked to add a
required field to a deployed application's Schema found and followed it, but nothing in the workflow it ran said a
migration was due: `mantle generate` rewrote `schema.sql` silently.

`mantle generate` (not `--check`) now prints one warning when it rewrites a `schema.sql` that already existed: the
databases built from the earlier file do not change, and if `git diff` of that file changes a table, a migration is due
(`mantle help migrations`). It does not classify the change, read git, connect to a database or decide whether a
migration is needed, so Decision 4's reasons stand: it shares no rule table with the DDL templates, and a reordered
`schema.sql` still prints it. A first generation, an unchanged file and `--check`, which already fails on a stale file,
print nothing. Decisions 1 to 4 are unchanged.
