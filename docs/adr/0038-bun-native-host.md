# ADR-0038: Bun is a native host

> **2026-10-10 amendment:** [ADR-0041](0041-native-driver-and-application-hook-ownership.md) governs native driver execution, SQLite handle ownership and application-owned before hooks. Its explicit removals supersede the corresponding historical guarantees below.

**Status:** Accepted for 0.2.0. Amends ADR-0036's reserved Bun host.

## Decision

`@aotter/mantle/bun` owns native drivers and Admin files. Core remains host-neutral;
PostgreSQL retains policy, convergence, SQL printing, SERIALIZABLE retries, timeout
and error mapping. `host: bun` defaults to `dialect: postgres` on first selection.
The CLI writes an application-owned Bun.serve entry and service once. Both native
PostgreSQL and bun:sqlite presets exist; neither imports Cloudflare or pg.

The PostgreSQL host takes a Bun.SQL pool configured with `prepare: false`.
Bun's prepared JSON parameter encoding serializes an already encoded JSON string
again. Refuse another configuration rather than silently changing stored values.
Pool reserve/release binds every operation to one connection. The host closes
its pool after the server and retained background work stop.

Bun exposes raw results without OIDs/typmods. Obtain exact result metadata from
`CREATE TEMP TABLE ... AS <query> WITH NO DATA`, read pg_attribute and drop the
temporary table, then execute the original statement once with raw text results.
A DML description is a data-modifying CTE under WITH NO DATA, which does not
execute its body. PostgreSQL owns all type inference, including numeric scale,
CASE, COALESCE and CTEs. Each descriptor runs in the statement's existing pinned
transaction. Views use a regular transaction because temporary DDL is forbidden
in READ ONLY: a read describes first, then runs `SET TRANSACTION READ ONLY` before
the statement, so the engine still refuses a write as it does on every other
PostgreSQL host. Creating the temporary table needs the TEMPORARY privilege on the
database (`GRANT TEMPORARY ON DATABASE ... TO <role>`); without it every read fails
with 42501 naming this requirement, and a read replica cannot serve this host.
Every transaction appends `pg_temp` to its search_path, on every PostgreSQL host,
so a temporary table on a pooled session never stands in for a Schema table (unless
the role's own search_path already names pg_temp earlier, which it should not).
A connection whose ROLLBACK failed is closed, never released to the pool.
This costs three metadata round trips per result. Replace it only when Bun
provides public RowDescription metadata; do not approximate money or time values.

The entry overwrites the trusted IP header from the socket; behind a reverse proxy
listed in TRUSTED_PROXIES, the client is the address that proxy appended last to
X-Forwarded-For (one trusted hop; an IPv4-mapped socket address is matched as
IPv4), so each client keeps its own sign-in rate limit. Bun.serve runs
with `development: false` and an error handler that answers Core's 500 envelope: Bun's
development page would show the exception, stack and paths. Admin assets reject
traversal, control characters and symlinks outside the installed bundle.
bun:sqlite runs with foreign keys on, as D1 does, and a Mantle batch waits for a
Better Auth transaction open on the same handle instead of becoming its savepoint.
Local OTP requires an explicit loopback PUBLIC_ORIGIN, a secret and bootstrap
email, as Cloudflare does.

Bun has no built-in cron scheduler in this preset. Enabled schedule Triggers are
refused before files are written; an application that supplies a scheduler uses
host none and invokes Mantle's schedule ingress explicitly. No polling scheduler,
workflow engine or new manifest grammar is introduced.

## Verification

Native PostgreSQL and SQLite run the same storage conformance suite. Native
regressions cover result names, JSON scalar/array values, exact numeric typmods,
microsecond timestamps, CTE/comment queries, star targets, connection
reservation, read-only reads, statement_timeout, pg_temp ordering, foreign keys,
transactions on a shared bun:sqlite handle and actual Better Auth
OTP/bootstrap-owner login on both engines. Both generated presets typecheck
against bun-types. CI installs pinned Bun and runs these on every PR.
