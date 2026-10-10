# Native query cleanup: local evidence

Issue #1428, ADR-0042. This follows #1427 at
`c10b04789d80de3527725b640be24bd8fa29411b`; see
[the earlier baseline comparison](native-driver-cleanup.md).

Four independent procurement applications ran actual Mantle plans, Auth,
Admin, Views, hooks, OCC, publishing, TTL and completed CSV responses. The
hosts were Bun SQLite, Bun PostgreSQL, local Wrangler D1 and local Wrangler
PostgreSQL using the Hyperdrive local connection setting. The HTTP matrix
recorded 58 requests per Bun host and 84 per Wrangler host: 284 total. Both
Wrangler hosts additionally completed 116 authentication/staff records each,
including real OTP sessions, OAuth/PKCE, invalid cookies and over 100 staff.
Expected denied access and stale/publishing conflicts remained denied/409.

| Observation | #1427 | Follow-up |
| --- | ---: | ---: |
| Warm OAuth bearer tools/list SQL messages, each Wrangler host | 2 | 1 |
| First OAuth bearer tools/list including key lookup | 3 | 2 |
| Native SQLite site/media SELECT while a Better Auth WAL writer is held | Previously required write batch | Native read succeeds |
| Already prepared site and matching Store boot | Unnecessary preparation writes | Native catalog/ledger reads; no write batch |
| Media ordering query plan | No matching ordering index | Native created_at/id index; no temporary ordering sort |

Native Bun SQLite and PostgreSQL each pass 103 conformance checks. Additional
native regressions verify actual Better Auth isolation and native Pool release,
partial timezone/assertion-trigger repair, ordered before-hook observations,
verb-specific hidden RETURNING, cursor ties/NULLs and native index bounds.
R2 binding tests verify concurrent heads, one native array delete, validation
before publication and cleanup under synchronous/asynchronous failures.

The changes also move immutable Admin descriptions to construction, parallelize
independent bootstrap reads, remove the successful invite prelookup through
Better Auth's official create API, and combine row projection/decoding. No
microsecond CPU speedup is claimed for these structural reductions.

The original audit's unsafe reductions remain explicitly resolved by retention:
TTL needs selected count/cursor even when a native trigger suppresses deletion;
Admin mutation prereads preserve 404/409 classification; publishing checks,
ordered hooks, fresh related rows and shared-DB policy reads preserve their
contracts. The legacy media index stays because its global name does not prove
ownership. Native PostgreSQL may legitimately choose a bitmap scan and Sort;
deep numeric OFFSET and substring searches retain their native costs.

SQL messages, native transactions, bindings, pool checkouts and physical
connections are distinct metrics. These shared-machine local observations do
not establish cloud Hyperdrive latency, D1 billing, universal page cost or
cross-database performance parity. No pool tuning, hidden retry, scheduler,
request-client manager or cloud resource was introduced. Raw credential-bearing
flow logs are withheld; all published evidence uses synthetic data.

Reproduce the repository checks with a disposable PostgreSQL database:

```sh
MANTLE_PG_URL="$DISPOSABLE_POSTGRES_URL" pnpm check
MANTLE_PG_URL="$DISPOSABLE_POSTGRES_URL" pnpm --filter @aotter/mantle test:bun
```
