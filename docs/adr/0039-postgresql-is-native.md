# ADR-0039: PostgreSQL is native, and node-postgres is its only driver

**Status:** Accepted (2026-10-08).

**Date:** 2026-10-08.

**Supersedes:**
- ADR-0035: the cross-dialect parity clauses (one shared subset, identical results on every dialect).
- ADR-0037: "moving from D1 to PostgreSQL still needs no rewrite", and the SQLite emulation it implies.
- ADR-0038: the Bun.SQL PostgreSQL host and its temporary-table result description. Bun's SQLite preset is unchanged.

## Context

Mantle has run PostgreSQL as an emulation of D1/SQLite, so that one manifest returns identical results on both engines.

### What the emulation costs

The PostgreSQL audit on the procurement fixture (S, M and L tiers, Bun and Workers hosts) measured three costs.

**1. No declared index can serve a paged sort.**
- Paging forces SQLite's NULL order: `ASC NULLS FIRST`, `DESC NULLS LAST` (`core/sql/run.ts:257,297`). The tiebreak is `id COLLATE "C"`.
- PostgreSQL btree indexes have the opposite default order (`postgres/storage.ts:88-93`).
- As a result, every Admin list and every View with an ORDER BY does a full scan plus a sort, even with an index:

  | Measurement | Today | With an order-matching index |
  |---|---|---|
  | Admin list, L tier, c=8 | 3 rps | 139 rps |
  | procurement report | 47 ms | 0.26 ms |

- Matching the indexes to the emulated order would mean a `NULLS FIRST` index migration, permanently.

**2. Translation shims in SQL that authors never see.**
- `_mantle_jget` reproduces SQLite's `->>` and `$` paths.
- `_mantle_bool` reproduces SQLite's integer truthiness.
- `_mantle_json_each` reproduces SQLite's json_each columns.
- `||` is cast to text, and pinned `DateStyle`/`IntervalStyle`/`extra_float_digits` settings exist only so that text decodes the way D1's does.

**3. A second driver on Bun that exists only to recover type metadata.**
- Bun.SQL exposes no column OIDs or typmods: verified on Bun 1.4.2, and its docs list column type transforms as unfinished.
- Mantle therefore describes every result through `CREATE TEMP TABLE … WITH NO DATA` plus `pg_attribute`.
- A View read costs 12 statements and 10 round trips on Bun.SQL, against 4 and 4 on node-postgres.
- Every Bun role also needs `TEMPORARY`.

### Who actually needs D1/PostgreSQL parity

No caller needs one manifest to switch engines without changes:
- **Cloud tenants** are moving to PostgreSQL.
- **On-premises single-organization deployments** run PostgreSQL on Bun.
- **D1 services** stay on D1.

What callers do need is that one PostgreSQL plan behaves the same on Bun and on Workers. The same app runs in Cloud and on-premises, and handler code and output schemas see the values directly.

## Decision

### 1. Each dialect is its own target

- A manifest targets one dialect.
- Mantle does not promise that a PostgreSQL manifest compiles for D1, or that a D1 manifest compiles for PostgreSQL.
- Mantle does not promise that the two dialects return equal values.
- The compliance suite checks each dialect against its own semantics, not against the other dialect.
- The closed allowlist stays: base for D1, reference for PostgreSQL (ADR-0037 decision 1).

### 2. PostgreSQL semantics are PostgreSQL's

**Ordering.** Paging uses PostgreSQL's own NULL order (`ASC NULLS LAST`, `DESC NULLS FIRST`), and the cursor follows it. The tiebreak uses the column's own collation, so declared indexes serve ORDER BY … LIMIT. An index matches a sort only when every key in it runs in the same direction; that remains an authoring rule for indexes.

**The SQLite shims go.** `_mantle_jget`, `_mantle_bool`, `_mantle_json_each`, the `||` text cast and the `$`-path lowering are removed. PostgreSQL manifests use PostgreSQL's jsonb operators, booleans and `jsonb_array_elements`. A manifest that relied on a SQLite-ism fails validation with a position and the PostgreSQL spelling.

**What stays.** Mantle's own functions that are not emulation stay:
- `_mantle_expect` (#1379);
- the policy rewrite;
- convergence;
- the boot-time settings check, reduced to what the remaining decoding needs.

### 3. node-postgres is the only PostgreSQL driver

- **Every host uses node-postgres (`pg` 8.23 or later):** the Bun preset (a `pg.Pool`), the Workers/Hyperdrive preset (a client per request), and any host composed by hand.
- **Request scoping and pipelining are the same everywhere:** `requestScoped` and the pipelined write path from #1379 run identically on every host.
- **The Bun.SQL host is removed**, along with its result description and the `TEMPORARY` grant.
- **Values come out of one decoder** (`decodeField` over RowDescription OIDs and typmods). Bun and Workers therefore return the same values for the same plan, with no separate value contract to maintain.

## Consequences

- **Indexes work on PostgreSQL**, with no `NULLS FIRST` migration. The keyset cursor (row comparison, #1391 follow-up) becomes the next step for deep pages.
- **There is one PostgreSQL code path** to test, profile and secure, and no `TEMPORARY` privilege.
- **This is breaking for existing PostgreSQL services:**
  - NULL position in sorted results changes.
  - Manifests that use SQLite JSON paths or integer truthiness on PostgreSQL must be rewritten.
  - The Bun PostgreSQL preset's entry changes.
  - Release notes give the rewrites.
- **D1 → PostgreSQL is a migration, not a switch:**
  - Export, rewrite the manifest's SQL, import.
  - aotter/mantle#1298 (portable dump) is re-scoped to data only.
  - aotter/mantle-home#251 (tenant upgrade from D1) becomes an explicit migration.
- **Bun gives up Bun.SQL's native client.** The audit measured no gain from it where Mantle's wrapper was absent: the session check ran 390 rps on Bun.SQL and 388 rps on node-postgres. If Bun later exposes column metadata and a measured gain appears, a Bun.SQL driver can return as a second implementation of the same contract.

## Alternatives

- **Keep parity and build `NULLS FIRST` indexes.** Rejected. It keeps every shim, needs an index migration on every existing database, and buys a guarantee no caller uses.
- **Keep Bun.SQL with a cached result description.** Rejected. It makes the wrapper cheaper but keeps it, keeps the `TEMPORARY` grant, and keeps two drivers to maintain.
- **Keep Bun.SQL, with a value contract both drivers normalise to.** Rejected. Two drivers plus a normalisation layer cost more than one driver, and the contract would need maintaining.

## How to apply

Each step is its own PR. Each is breaking where noted.

1. **Bun preset on node-postgres.**
   - `cli/preset.ts`/`generate.ts` write a `pg.Pool` entry with `requestScoped`.
   - Remove `bunPgConnect`, `bunPostgresStorage` and the result-description path from `src/bun`, and the `TEMPORARY` note from the handbook.
   - `test/bun/native.ts` runs the PostgreSQL conformance on node-postgres under Bun.
2. **Native ordering.**
   - `run.ts` stops emitting NULLS clauses on PostgreSQL. The dialect supplies its default NULL order, and the cursor predicate follows it.
   - The tiebreak drops `COLLATE "C"` on PostgreSQL.
   - Add EXPLAIN-based tests showing a declared index serves each paged sort.
3. **Remove the SQLite shims** from `postgres/lower.ts`, `print.ts` and `storage.ts` `FUNCTIONS`.
   - Add validation diagnostics that name the PostgreSQL spelling.
   - Rewrite the PostgreSQL compliance fixtures and the reference suite in PostgreSQL's own semantics.
4. **Docs and skills.**
   - The handbook's dialect pages and the consumer skills say that each dialect is its own target.
   - Add release notes with the rewrites.
5. **Follow-ups from the audit** (#1391 and the audit report), in this order:
   - keyset cursor;
   - auth: drop the discarded JWT header, plain reads;
   - SQL compile cache;
   - boot trim;
   - convergence safety (CHECK diffing, re-reading the fingerprint under the lock).

## Implementation status

Accepted. Implementation follows in the stacked PRs listed under How to apply.
