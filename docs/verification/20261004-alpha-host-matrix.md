# 0.2.x populated host matrix acceptance — 2026-10-04

All four local services passed the same populated procurement acceptance case.
This is functional acceptance at scale, not a sustained-load benchmark or a
remote Cloudflare deployment certification. Reproduce with
[scripts/alpha-matrix](../../scripts/alpha-matrix/README.md).

## Provenance

- Frozen remote `0.2.x`: `e1c4ef4244d8f21c832e10547223ef748ece5052`.
- Tested SDK fix: `3dec8dcd`, package version `0.2.0-alpha.1`.
- SDK tarball SHA-256: `5518bbb0a96c9a065ca8c7630faf561454c19691b9d7c2cb72c51bce4a712af5`.
- UI tarball SHA-256: `2f7dc5a3649e510557f872bc10208b8cebed4e4750aff64ccdb354b6953cb844`.
- Consumer lock SHA-256: `28147293b7cc48425ce9cb14a90771e9ef9f1bbae86eb3fabb861f17f6c68eb6`.
- Bun 1.3.14; Node 26.3.0; PostgreSQL 17.9; Wrangler 4.129.0;
  Playwright 1.63.0 with real Chrome. Exact packed consumers, no source aliases.

## Matrix

| Official preset | Actual local host/storage | Seeded requests / vendors / related items | Admin browser + API + MCP |
| --- | --- | --- | --- |
| Bun × SQLite | Bun, native SQLite | 20,000 / 500 / 300 | PASS |
| Bun × PostgreSQL | Bun.SQL, PostgreSQL | 20,000 / 500 / 300 | PASS |
| Cloudflare × SQLite | workerd, local D1 | 20,000 / 500 / 300 | PASS |
| Cloudflare × PostgreSQL | workerd, local Hyperdrive connection to PostgreSQL | 20,000 / 500 / 300 | PASS |

Each service was started, received real OTP-authenticated owner/staff sessions,
and imported real stored data. Database reads verified the 20,000 seeded
request IDs; additional business scenarios create more rows. Related compound
sorting and complete 300-row CSV exports passed on all four presets; the
failure described against 0.1.4 in #1316 did not reproduce on this baseline.

The case covers small automatic approval, the exact 10,000 TWD threshold,
large manager/finance/payment stages, invoice matching, self-approval denial,
custom business role revocation/restoration, unauthorized access, invalid
procedure inputs and invalid dynamically imported rows. Insufficient budget
rolls back the entire multi-statement SQL batch. Eight concurrent HTTP writers
produce one commit and seven version conflicts on every preset.

Actual Admin browser interaction covers entry creation, enum editing,
save/publish/unpublish, populated collections, custom roles, SQL joined report,
expanded manifest flow and data-dependency toggling. No page errors occurred.
Search and actual staff MCP tool writes passed. Full-page screenshots were
captured for all four; Traditional Chinese populated table and flow screenshots
were manually inspected for readable labels, thresholds and branch order.
Evidence stays in the external consumer's `evidence/<pair>/`: `result.json`,
`extras.json`, and screenshots. Private session caches and OTP logs are excluded.

## Discovered defect and minimal correction

Fresh external consumers resolve Better Auth 1.7.2 / Kysely 0.29.6. The official
Bun/PostgreSQL preset failed TypeScript because its auth pool lacked Kysely's
required `options` property. PR [#1318](https://github.com/aotter/mantle/pull/1318)
adds the empty options contract to both SDK PostgreSQL pool shims and a contract
check; no new runtime dependency or alternate host wiring. The Cloudflare/PG
setup documentation now includes the required `@types/pg` development dependency.
All four fresh generated consumers then passed `generate --check` and TypeScript.
The materializer was independently replayed in a new consumer directory.

## Regression and release boundaries

The frozen baseline passed `pnpm check`: Core 780 passed with three existing
conformance TODOs (one skipped file), UI 209 passed, plus packed Worker consumer,
TypeScript, build, boundary, skill, plugin, release self-test and doc checks.
Native Bun conformance separately passed 79 tests for SQLite and 79 for PG.
The fix passed 17 targeted PostgreSQL-auth/CLI tests and all four consumer
TypeScript checks. Final `pnpm check` passed on clean commit `1b7c0a08`: Core
781 passed / three existing TODOs, UI 209 passed, and packed Worker consumer
passed with identical SDK/UI artifact hashes above. Native Bun was re-run and
passed 79 SQLite + 79 PostgreSQL checks. PR
[#1319](https://github.com/aotter/mantle/pull/1319) stacks the reproducible gate
on #1318. Subsequent edits only tighten fixture assertions and record results.

Optional site settings explicitly return 501 because these presets do not
configure that capability. Media has no blob/R2 binding in this fixture and is
not accepted by this run. Deployed Hyperdrive, sustained production load and
external identity-provider integration remain separate gates.

Auth follow-up #1315 was not in the frozen baseline; PR #1320 brings it into
the stack afterwards. With it, the Core suite passed against PostgreSQL 16
(780 passed; the two failures are sandbox-only: a `chmod` check that root
bypasses and the local Hyperdrive Worker test, which also times out on #1319)
and native Bun passed 79 SQLite + 79 PostgreSQL checks. The populated four-host
matrix was not re-run with #1315: re-run it before the alpha. The release
controller currently maps alpha versions to `develop`; integrate the reviewed
0.2.x stack into the governed release branch before dispatching an alpha.
No release was published, tagged or merged by this acceptance run.
