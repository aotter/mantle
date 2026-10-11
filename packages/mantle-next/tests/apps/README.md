# Four local native applications

The public fixture is synthetic procurement data: 120 requests for each of two owners. Source fields challenge owner isolation, exact microseconds, dates, large integers, nullable/tied sort keys, booleans and nested JSON. SQL procedures test validation before writes, native atomicity, explicit OCC and output validation after commit. Computed scalar expectations follow each dialect's native behavior; the test does not require cross-engine representation equality.

From this package, after building Core and Mantle Next:

```sh
# Set explicit disposable local databases; no default PostgreSQL connection is used.
export MANTLE_NEXT_BUN_PG_URL='<local-disposable-db-url>'
export MANTLE_NEXT_WORKER_PG_URL='<local-disposable-db-url>'
export WRANGLER_LOG_PATH=/tmp/mantle-next-wrangler.log
bun run test:native
```

A target argument selects `bun-sqlite`, `bun-postgres`, `cloudflare-d1` or `cloudflare-postgres`. SQLite uses a real native in-memory database. PostgreSQL creates a fresh schema and uses official PoolClient/Client objects. Worker applications use official local Wrangler D1 or a local Hyperdrive binding; private config/logs live outside this checkout. No cloud resources are needed. Generated application code and schema SQL live in the ignored `.generated/` directory.

Views currently return the complete authored SELECT as typed `Row[]`. These tests do not assert 0.2 pagination, default limits or cursor compatibility.

After a coordinated quiet grant, choose a fresh private output directory:

```sh
MANTLE_NEXT_QUIET_SLOT=1 MANTLE_NEXT_BENCH_OUTPUT=/tmp/mantle-next-fresh-results bun run bench
```

The benchmark first runs semantics, then pairs generated/native reads on the same driver in three alternating rounds, 200 samples per variant per round. Native reads include equivalent authorization, cached official Zod input validation and one-pass typed row projection; PostgreSQL reads use official field metadata and boundary codecs. Files preserve samples and artifact hashes. Worker timer quantization limits small-duration interpretation. These measurements cover this fixture and API, not cloud latency or complete 0.2 feature parity.
