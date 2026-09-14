# Route-owned Cloudflare readiness (#808)

Status: accepted for the unreleased #806–812 implementation. Follows ADR-0019
(preparation owns migrations) and amends ADR-0014's unconditional HTTP boot rule.

The facade assembles immutable route projections once, then prepares only for
routes that consume canonical storage. It retains one retryable preparation
promise, the sealed plan and Better Auth's existing global AsyncLocalStorage,
`ready` observation, failed-assembly eviction and HTTP `waitUntil` ownership.

| Surface | Readiness, including an empty database |
| --- | --- |
| Consumer constant health, `/api/views` catalog | No content preparation. |
| Static Admin shell and assets | No content preparation; incomplete Auth still fails closed as before. |
| Manifest View/Trigger | Prepare before credential resolution, then use the same runtime invocation. |
| Admin API, configured Auth base path, OAuth UI/discovery | Prepare before session/provider work. Auth tables share canonical migrations. |
| MCP, including missing-token challenge | Prepare before the selected Auth verifier. A custom Auth implementation may require D1 even for a denied request; the facade cannot assume otherwise. |
| Public page/list/discovery and favicon fallback | Their existing `ref.get()` starts preparation when content is needed. |
| Consumer extension handlers | Call the supplied `getRuntime()` or `ref.get()` before using Mantle content or database-backed Auth. Pure handlers need neither. |
| Queue/scheduled `getRuntime(env)` | Await both runtime preparation and Auth initialization, unchanged. |

No deployment-time migration flag or KV readiness authority is introduced. A
current database's first protected route needs one fingerprint SELECT; an empty
or changed database performs canonical setup there. Concurrent first uses share
that work. A failed preparation returns the facade's redacted 500, and later
requests retry. Static availability is not a promise that data is ready.

The pre-change full-facade fixture recorded 106 SQL operations for its empty-DB
health request (its four Schemas include indexes), then 1 fingerprint operation
for each new-state health/catalog/shell/challenge. These are statement counts,
not network round trips. Its dry-run bundle was 3,921.40 KiB / 690.43 KiB gzip
with Wrangler 4.124.0 and compatibility date 2026-07-08. Esbuild attributed
1,342,428 emitted bytes to Better Auth, 76,078 to Admin, 24,624 to Web and
203,130 to Runtime; the rest includes transitive libraries and adapter code.
Byte attribution does not measure startup CPU. We retain static imports and
immutable mount-time projections: deferring those modules has not yet been
justified by a startup profile. The final #812 report owns the separate startup,
preparation-wall and warm-dispatch measurements.

Post-change full-facade workerd checks pass all 13 operation gates: empty-DB
health and fresh-state health/catalog/shell perform zero **content** queries;
the challenge retains its one fingerprint query. The fixture Auth is a stated
stub. A separate real Better Auth regression records one eager oauthResource
lookup while `ready` initializes; Better Auth 1.7.2 defers missing-table resource
seeding to first access. Subsequent static requests perform no additional Auth
queries. This background initialization is retained, not counted as eliminated
content preparation or hidden behind a zero-total-SQL claim.
