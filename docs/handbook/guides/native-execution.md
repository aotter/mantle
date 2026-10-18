# Generated native execution

Views and SQL Procedures execute compiled SQL through the selected native driver. The compiler stays build-time only. The app owns native handles, pools, verified Caller, boundary validation and resources. Import direct operation entries to omit unused operations.

Supported targets are Bun SQLite/PostgreSQL and Cloudflare D1/PostgreSQL. The [driver boundary is open; dialects are closed](../concepts/runtime-and-adapters.md#drivers-and-dialects). Generation emits initial SQL; [the runtime runs no DDL or schema checks](../concepts/runtime-and-adapters.md#schema-installation-and-migrations).

## Query inputs, values and outcomes

The default typed query accepts application-validated parameters and a verified
Caller, binds literal SQL using the official driver, and returns that target's
native result types. Generated TypeScript is a compile-time contract, not a
validator for untrusted data. The application must validate external input before
calling it. Generate-time schema/SQL diagnostics remain mandatory.

The bare query must not recursively scan JSON, construct validators, revalidate
known database rows, normalize errors across databases, or require universal row
decoding. Direct in-process values are owned by their application caller; input
bounds, JSON defaults and computed result types are handled explicitly by the
application boundary rather than assumed from TypeScript.

Driver-native PostgreSQL types and SQLite/D1 types need not match, except for
declared date-time and date outputs (below), which the SQL formats. That does not
justify overriding every PG type parser or adding a generic decoder to the bare
query. Authored output names should be emitted into SQL where valid, avoiding
an extra per-row projection merely to repair names already known at generation.

Selected REST/MCP/Admin boundaries use static generated column lineage. Declared
integers (including aliased system versions) are `number | string` on every
target, `| null` unless the View proves the column NOT NULL ([nullability](../reference/view.md#results-and-paging)): safe integers become numbers; unsafe integers remain exact decimal text.
Selected SQL projections cast integers and hidden integer cursor keys to text
before the driver reads them, preserving stored int64 values on SQLite/D1 and
PostgreSQL. Values already rounded when written
(e.g. by a JavaScript number) cannot be recovered.
`views/<name>.ts` exports both driver-native `Row` and `WireRow` (declared wire fields agree across targets);
`paged/views/<name>.ts` keeps native `Row` rows; REST/MCP use separate
`paged/wire/views/<name>.ts` SQL and convert at their boundary. SQLite/D1 declared JSON
and boolean columns, and computed outputs that are JSON documents by construction
(JSON aggregates and builders), become JSON values and booleans, preserving aliases and nulls;
PostgreSQL already returns those native values.
Declared real/float outputs remain numbers. Computed outputs without proved lineage,
SQL Procedures and app-owned ref results retain native values and types.
Bare Views/Procedures, the Store, web pages and internal paged Views stay
driver-native; bare queries and the Store receive no integer SQL projection,
transport conversion or runtime schema interpreter.

Declared authorization, ownership/TTL SQL policy, explicit OCC and atomic writes
remain required. Generate them as the native application would implement them.
Transaction rollback and uncertain COMMIT handling must still preserve data-loss
protection and client disposal responsibility; native errors are rethrown (one exception, below), and
redaction before they reach HTTP users belongs to the application boundary through `wire` / `surfaceFailure`. Removing generic error
normalization does not authorize dropping transaction outcome evidence.

**Single-statement writes:** a Procedure with one statement is atomic on its own
and runs in autocommit, with no BEGIN/COMMIT on PG or native transaction on Bun
SQLite. A row-classified statement touches at most one row (one-row INSERT or
unique `id =`), so a failed count check after autocommit has changed nothing.
On PG it runs at the server's default isolation, not SERIALIZABLE: a concurrent
OCC loser re-evaluates its `version =` predicate, matches zero rows and returns
`CONFLICT` instead of SQLSTATE 40001. A server ErrorResponse (SQLSTATE and
severity) is a known rollback and is rethrown natively, except a unique violation (23505, SQLite's `UNIQUE constraint failed`), which, in a generated Procedure or a Store write, is `ContractError("CONFLICT")` with the native error as `cause` on every target, and except connection,
resource and shutdown classes (08, 28, 53, 57, 58, XX), which, like any failure
without a server response (lost socket), are `OUTCOME_UNKNOWN`. SQLSTATE is
`errno` on Bun.SQL and `code` on postgres.js. Multi-statement Procedures run in
`begin("isolation level serializable", ...)`: a failure before the callback
returns was rolled back by `begin`; only a failed COMMIT is classified as above.

**Date-time wire form:** a View output that is a declared `date-time` column
(including `created_at`/`updated_at`) returns the handbook's wire form, an ISO
string in UTC with six fractional digits; a declared `date` returns `YYYY-MM-DD`.
The generator wraps those SELECT items before the dialect's own printer prints them
(`to_char` on PostgreSQL, `strftime`/`date` with floor arithmetic on SQLite), so the
database formats them and no row decoder runs. Bun.SQL's `Date` would drop
microseconds. A write's `RETURNING` of such a column gets the same form. Inputs bound to a declared date-time take the same ISO text (or a
valid `Date`), and a declared date takes `YYYY-MM-DD` text, on every target: a
timestamp needs `Z` or an offset and hours 00-23, a day that does not exist is refused with `SQL_TYPE` before the write, and SQLite receives
microseconds and days while PostgreSQL receives the canonical text. Computed values
(`now()`, `date_trunc`, `CAST`) carry no declared type and stay driver-native; on
PostgreSQL through Bun.SQL that is a `Date`, which drops microseconds. Other
declared scalars are driver-native.

JSON parameters are text on every target (a JavaScript array would otherwise be bound as a PostgreSQL array): an input field read as JSON takes its authored array or object, which the generated query serializes, and a string is bound as it is. Bare PG SQL declares each JSON parameter as text
(`CAST(CAST($n AS text) AS jsonb)`), so Bun.SQL sends the text verbatim instead of
JSON-encoding it again; generation refuses a JSON parameter used any other way. SQLite bool/date/timestamp/numeric parameters use their declared
storage representations. Bound optional fields become explicit required values,
with null representing absence; D1 cannot bind undefined. Native output keys are
SQL names rather than a post-query camel-case projection. PG uses the driver's
default type parsers (including Date and int8 strings); custom application parser
configuration changes application-owned behavior. Procedures expose raw
`{ results }`, not a claim of validated authored output.

The application resolves a verified Caller once at its entry, using its selected
auth module or identity. Bare queries accept that application-supplied Caller and
do not verify credentials. SQL binds the caller subject directly; a system
caller is application-owned and never wire input.


## PostgreSQL settings

The app owns role/database configuration, statement timeouts, pool lifetime and retries. Configure persistent session settings there rather than issuing request-time SETs; Hyperdrive does not retain them. UTC is useful for application-owned timestamp expressions; generated declared timestamp outputs are formatted explicitly. Requests neither set nor validate role settings.

## Ref Procedures

Generation emits a `Handlers` interface. Pass implementations at `store(db, caller, { handlers })` and to selected surfaces. `requires` is checked before the ref handler receives `(ctx, input)`; `ctx` contains `{ caller, db, store }` bound to the actual Caller and transaction. Missing implementations fail typechecking; a missing runtime key is `HANDLER_NOT_REGISTERED`. Handler failures propagate unchanged. Handlers own business rules, side effects and explicit transaction boundaries.

Lifecycle and schedule Triggers and dynamic authorization guards are rejected by generation. Use app-owned handlers and scheduling. HTTP/MCP Triggers expose declared Procedures.

## TTL maintenance

A TTL Schema generates `<schema>.sweepExpired(db, caller, { limit?, cursor?, delete? })`
in `procedures/<schema>.sweepExpired.ts`. Only an application-created system caller
with a non-empty reason may invoke it; HTTP/OAuth callers cannot become system
callers. The app owns scheduling. Schedule/lifecycle Triggers remain refused.

The sweep returns `{ scanned, removed, nextCursor? }`, defaults to 500 candidates,
and accepts limits 1..500. `delete: false` scans without deleting. Cursors belong
to that Schema's sweep. NULL and future TTL values survive; a timestamp exactly
at the shared dialect cutoff expires. Maintenance deliberately ignores scope and
publishing visibility, deleting expired rows across tenants. Candidate selection
and deletion run atomically through the native driver with its existing uncertain
transaction outcome handling. Native triggers may suppress deletes, so scanned
and removed counts can differ; the cursor advances over selected candidates.


Keep the sweep import in the scheduled entry; apps selecting unrelated operations
exclude maintenance code. Set `triggers.crons` in Wrangler yourself. The SDK's
`toCloudflareCron` helper (the `cron` subpath) converts five-field POSIX schedules
(weekday 0=Sunday) to Cloudflare weekdays (1=Sunday); it refuses ambiguous schedules
that restrict both day-of-month and weekday. This is conversion only, no dispatcher.
Bound scheduled work to your host's execution budget; keep the returned cursor
when continuing a larger sweep in a later invocation.


See [publishing and translations](../concepts/lifecycle-and-locales.md), [Store](typed-queries.md), [surfaces](../reference/surface.md) and [Admin](native-admin.md) for selected capabilities.
