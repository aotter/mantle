# Populated 0.2.x host/dialect acceptance

This opt-in local release gate runs **real generated services**, exact packed SDK/UI
packages and a real Chrome browser. It is outside the default unit test suite:
PostgreSQL, Bun and Chrome must be available. Cloudflare runs local workerd through
Wrangler, D1 runs local SQLite, and Hyperdrive uses its localConnectionString.
It does not validate a deployed Cloudflare account or publish a release.

## Prepare

Use Bun 1.3.14, Node 22+, pnpm 9+, Chrome and PostgreSQL. Create two **disposable,
separate databases** with a role allowed to converge tables and create temporary
tables (native Bun metadata needs TEMPORARY; ADR-0038). Keep other data out.

```sh
pnpm install --frozen-lockfile
pnpm build
BUN_PG_URL='postgres://user:password@127.0.0.1:5432/alpha_bun' \
CF_PG_URL='postgres://user:password@127.0.0.1:5432/alpha_cf' \
node scripts/alpha-matrix/prepare.mjs /absolute/new/consumer-directory
```

Preparation refuses an existing directory, packs the current build, installs it
as a consumer (no SDK source aliases), authors the same manifest for all four
pairs, generates their official presets and runs `generate --check` and
TypeScript checking. The Hyperdrive placeholder is intentional locally; a real
config is necessary before deployment. Consumer peer rules only accommodate
pnpm's exact-file peer handling; the installed versions are the packed versions.

## Run one pair at a time

In each generated pair directory, keep its service running in a terminal:

```sh
# bun-sqlite: 4421; bun-postgres: 4422 (their .env supplies the port/database)
bun src/index.ts

# cf-sqlite: 4423; cf-postgres: 4424
WRANGLER_SEND_METRICS=false CI=1 ../node_modules/.bin/wrangler dev \
  --local --ip 127.0.0.1 --port 4423 --inspector-port 0
```

Capture each host's output in `/private/tmp/mantle-alpha-<pair>.log`: the test
reads the real locally printed OTP. These logs contain short-lived codes and
must not be committed. From the **consumer root**, run:

```sh
node e2e.mjs bun-sqlite
node extras.mjs bun-sqlite
# Repeat for bun-postgres, cf-sqlite and cf-postgres on their ports.
```

The same case includes 20,000 requisitions, 500 vendors, 300 related items,
budgets, custom business roles and seven real users. It checks:

- Browser OTP bootstrap-owner login; real staff grants and outsider denial.
- Store-validated data imports, rejection of invalid dynamic rows, searchable
  announcements, indexed filters/sorts and disjoint cursor pages.
- Related scope + compound-index sorting (actual ordered values, not only
  HTTP success), filtered amount order and complete sorted CSV export.
- Small, threshold and large procurement; three approval/payment stages,
  self-approval rejection, role revoke/restore and exact invoice matching.
- Whole SQL-batch rollback on insufficient budget and stale-version conflicts.
- Actual Admin form/enum editing, save, publish/unpublish, joined report,
  expanded developer flow and data-relation toggle, with no page errors.
- Staff MCP discovery, actual role creation, MCP App resources and eight
  concurrent HTTP writers: exactly one commit, seven conflicts.
- Explicit 501 for unconfigured optional site settings. Media has no blob
  binding in these default presets and is outside this populated fixture.

The owner-only importer is a **test application handler**, not an SDK endpoint.
It writes in chunks of ten to stay below the sealed SQL program's IR work
budget; each chunk is atomic, the entire import is not. Existing IDs are ignored
for recovery. Fresh databases/directories give the cleanest reproducible run:
re-running business scenarios consumes more budget. Auth rate limits stay on;
the test honors 429 delays with at most three retries per request. `.auth-*.json` files cache locally issued sessions
for recovery and must remain private/uncommitted. A cached session that expires
requires deleting that pair's private auth files and signing in again.

Results and full-page screenshots are under `evidence/<pair>/`. Failures preserve
`failure.txt` and a screenshot; do not infer success from a process being up.
Screenshots are author inspection evidence, not a formal usability study.

## Full regression gate

Use a third disposable PostgreSQL database for the SDK suite. Commit SDK changes
before `pnpm check`: the packed-consumer check requires immutable clean Git SHA
provenance. Native Bun conformance is separate from `pnpm check`.

```sh
MANTLE_PG_URL='postgres://user:password@127.0.0.1:5432/alpha_suite' pnpm check
MANTLE_PG_URL='postgres://user:password@127.0.0.1:5432/alpha_suite' \
  pnpm --filter @aotter/mantle test:bun
```

This is functional scale/concurrency acceptance, not sustained load, production
latency or remote Hyperdrive certification. Preserve the exact consumer lockfile
and tarball SHA-256s with the run report.
