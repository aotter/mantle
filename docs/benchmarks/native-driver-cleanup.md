# Native driver cleanup: local four-host evidence

Issue #1426, ADR-0041. Baseline: develop commit
`86dd29ead8cd57721b63e847c551fef237d3b1c5`. Candidate: the implementation in this PR.
All records use synthetic procurement data and local engines, with roughly
2,000 requests/tasks, seven editor relations, and twenty operations.

Four independent applications ran real Mantle plans and surfaces: Bun SQLite,
Bun PostgreSQL, local Wrangler D1, and local Wrangler PostgreSQL through its
Hyperdrive local connection setting. Bun used the native Database/Pool;
Workers used native D1/pg Clients. Test-only observation wraps driver/binding
methods and measures the completed response body, without scheduling SQL.

The final HTTP matrix recorded 57 requests for each Bun application and 84 for
each Wrangler application (282 total). Bun was rerun after the Auth handle
ownership review fix; existing seeded data omitted the initial seed request. The two Wrangler applications also ran
116 records each covering invalid cookies, real OTP sessions, OAuth/PKCE and
staff lists with more than 100 entries. Expected stale OCC and publishing
same-row conflicts remained 409; access-denied cases remained denied. These
are local integration observations, not cloud Hyperdrive benchmarks.

| Observation | Baseline | Candidate |
| --- | --- | --- |
| Bun SQLite plain Store SELECT native transactions | 1 | 0 |
| Bun SQLite editor with seven relations native transactions | 9 | 0 |
| Bun SQLite five hook updates native transactions | 6 | 1 (write batch only) |
| Cookie session + list SQL messages, all four applications | 3 | 2 |
| Editor with seven relations SQL messages, all four applications | 11 | 10 |
| Five-page CSV SQL messages, Wrangler applications | 7 | 6 |
| Wrangler PG editor physical connections | 7 | 10 |
| Wrangler PG five hook updates physical connections | 1 | 6 |
| Wrangler PG five-page CSV physical connections | 5 | 6 |

Session SQL is reduced by Better Auth's official `advanced.database.joins`
option. Hook snapshots and publishing checks still need their queries; this
cleanup does not claim to remove those queries. SQL messages, SQL commands,
pool checkouts and physical connections are separate quantities. A counted
Bun `query()` call is not evidence that its cached statement was recompiled.

Three repeated local samples give the following illustrative median completed
request times. Runs share a machine with verification work; these timings are
not a controlled regression threshold or evidence that every path improved.

| Path | Baseline ms | Candidate ms |
| --- | ---: | ---: |
| Bun SQLite five hook updates | 10.95 | 7.99 |
| Bun PG five hook updates | 13.30 | 34.04 |
| Wrangler D1 editor with seven relations | 22 | 21 |
| Wrangler PG editor with seven relations | 68 | 72 |
| Wrangler PG five hook updates | 31 | 59 |
| Wrangler PG five-page CSV | 98 | 128 |

The increased Worker connection count and sequential PG write cost are explicit
tradeoffs of removing request client sharing and Mantle pipelining. No pool,
retry loop, session cache or batching manager is added to hide them.

Repository checks reproduce native behavior with disposable PostgreSQL:

```sh
MANTLE_PG_URL="$DISPOSABLE_POSTGRES_URL" pnpm check
MANTLE_PG_URL="$DISPOSABLE_POSTGRES_URL" pnpm --filter @aotter/mantle test:bun
```

The Bun suite verifies native engines, separate SQLite connection isolation,
prompt same-handle rejection, auth bootstrap, and native Pool release. A real
Better Auth transaction held across an await on the shared native PG Pool
leaves ancillary reads on the committed role; after commit they see the new
role. A separately acknowledged Store write survives a later Auth rollback. Runtime
and lifecycle suites verify hook side effects/veto, caller authorization,
explicit OCC, retained publishing protection, and read-only guards. Generated
preset tests and Worker consumer checks validate the published composition.
No cloud resources were created and no production-performance claim is made.
