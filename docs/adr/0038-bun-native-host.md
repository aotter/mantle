# ADR-0038: Bun is a native host

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
in READ ONLY; Core still validates read-only IR and its closed function list.
This costs three metadata round trips per result. Replace it only when Bun
provides public RowDescription metadata; do not approximate money or time values.

The entry overwrites the trusted IP header from the socket. Admin assets reject
traversal and symlinks outside the installed bundle. Local OTP requires an
explicit loopback PUBLIC_ORIGIN, a secret and bootstrap email, as Cloudflare does.

Bun has no built-in cron scheduler in this preset. Enabled schedule Triggers are
refused before files are written; an application that supplies a scheduler uses
host none and invokes Mantle's schedule ingress explicitly. No polling scheduler,
workflow engine or new manifest grammar is introduced.

## Verification

Native PostgreSQL and SQLite run the same storage conformance suite. Native
regressions cover result names, JSON scalar/array values, exact numeric typmods,
microsecond timestamps, CTE/comment queries, connection reservation and actual
Better Auth OTP/bootstrap-owner login. CI installs pinned Bun and runs these.
