# Swolhalla: real-data local before/after evidence

Issue #1428. A read-only Cloudflare D1 query captured one consistent application-data snapshot. Cloudflare's whole-database export refuses FTS5, so the local snapshot recreates its virtual index from native schema SQL. Auth credentials were excluded; authenticated HTTP uses synthetic local sessions. No remote writes or deployment occurred.

The snapshot has 47 workouts and 474 sets for one workout owner. Each version uses the same checked-out application manifests/handlers and rows; undeclared production columns are retained. This does not establish that the checkout equals current production source. Tests prove original-row hash preservation, scoped complete pagination without duplicates, synthetic write replay, OCC conflict and deletion.

Native Bun SQLite uses official drivers. Three serial rounds per version use five warmups and thirty samples, with alternating version order and a fixed clock. The audit baseline is `86dd29e`; deployed alpha.2 is a separate installed-package comparator, not an isolated cleanup comparison. The candidate includes prerequisite #1427. Values below are the median of the three round medians; ranges show their variation. These measure runtime/handler cost, excluding HTTP, auth and D1 RPC.

| Scenario | Audit ms (range) | Deployed alpha.2 ms (range) | Candidate ms (range) | Native transactions audit → candidate |
| --- | ---: | ---: | ---: | ---: |
| list-workouts:first | 0.838 (0.661–1.429) | 3.176 (2.758–4.766) | 0.486 (0.471–0.510) | 1 → 0 |
| list-workouts:deep-limit10-page-4 | 0.498 (0.334–0.510) | 2.397 (1.936–2.452) | 0.112 (0.110–0.120) | 1 → 0 |
| list-workouts:all-pages | 2.476 (1.724–2.845) | 10.885 (10.401–12.062) | 0.694 (0.669–1.809) | 5 → 0 |
| workout-sets | 0.380 (0.346–0.430) | 1.999 (1.904–4.067) | 0.170 (0.164–0.187) | 1 → 0 |
| personal-records:all-history | 1.064 (1.052–1.101) | 2.758 (2.736–5.726) | 0.716 (0.674–0.730) | 1 → 0 |
| exercise-history | 0.750 (0.581–0.761) | 4.950 (2.397–5.379) | 0.378 (0.318–0.394) | 1 → 0 |
| weekly-volume | 1.352 (1.340–1.422) | 3.395 (2.966–4.878) | 0.971 (0.900–0.991) | 1 → 0 |
| weekly-volume:all-pages | 3.690 (3.180–7.584) | 8.780 (8.727–10.781) | 2.214 (2.150–2.228) | 3 → 0 |
| hall | 14.390 (13.498–20.057) | 29.304 (24.017–29.984) | 12.418 (12.333–12.478) | 5 → 0 |
| training-report | 5.368 (5.045–5.477) | 14.825 (13.490–17.515) | 3.915 (3.862–4.314) | 5 → 0 |
| write:log | 3.016 (2.515–3.208) | 5.185 (4.837–6.200) | 2.371 (2.315–2.781) | 3 → 1 |
| write:replay | 1.779 (1.630–2.078) | 4.170 (4.135–4.199) | 1.284 (1.234–1.401) | 3 → 1 |
| write:replace | 2.867 (2.398–3.003) | 5.036 (4.658–5.639) | 4.166 (2.325–4.324) | 4 → 1 |

Read medians improved in these samples, while replacement writes regressed versus the audit baseline. Timing ranges overlap and tails vary substantially: candidate training-report per-round p95 ranges from 5.37 to 108.95 ms. No universal latency improvement or production/cloud speedup is claimed.

Native SQL statement counts stay unchanged: one for simple reads, five for Hall/report and full workout pagination, three for full weekly-volume pagination, and six/six/ten for log/replay/replace. Native transactions are counted separately from SQL statements and implicit BEGIN/COMMIT. Cached-query requests are not measured cache hits.

The actual unchanged application also runs in local Wrangler before/after with matched Core/UI versions and official Auth peers (1.7.7). All four Auth package versions are asserted through module resolution from Core’s own package context before each run. These measurements supersede an earlier fixture that checked only top-level versions while Core’s nested peers still resolved 1.7.2. Since the snapshot excludes Auth tables, its copied Auth readiness marker is cleared before boot; the unchanged SDK then runs the official Auth migration and schema validation before synthetic sessions are inserted. Hall, report, Admin bootstrap, complete CSV and MCP Hall responses match byte for byte; anonymous guards remain enforced. HTTP timing evidence follows below. Private snapshots, row hashes and raw responses remain outside the public repository.

The HTTP comparison is audit `86dd29e` before → cumulative candidate after. Three quiet HTTP rounds per variant use five warmups and thirty measured requests per route: 900 measured authenticated responses total. The exact complete-body hashes match across every variant/sample without normalization. Times include local HTTP, synthetic authentication, workerd, D1 and reading the complete response body.

| Route | Before round p50 ms | After round p50 ms | Before round p95 ms | After round p95 ms | Before D1 calls/statements/batches | After D1 calls/statements/batches |
|---|---|---|---|---|---|---|
| hall | 66.18, 40.73, 34.27 | 62.08, 39.69, 42.03 | 136.13, 91.58, 52.55 | 127.17, 159.90, 93.71 | 9/9/5 | 7/7/0 |
| report | 42.88, 19.92, 22.08 | 34.18, 21.02, 17.86 | 67.03, 36.26, 39.79 | 58.99, 29.19, 26.78 | 7/7/5 | 6/6/0 |
| admin:bootstrap | 18.08, 25.81, 14.29 | 11.80, 13.05, 10.89 | 34.28, 38.68, 27.81 | 24.95, 19.10, 20.13 | 3/3/1 | 2/2/0 |
| admin:csv | 27.83, 28.95, 27.72 | 11.49, 13.96, 12.06 | 44.74, 45.43, 42.37 | 16.44, 23.35, 19.79 | 3/3/1 | 2/2/0 |
| mcp:hall | 67.00, 72.23, 46.85 | 44.51, 52.85, 62.34 | 123.63, 182.67, 75.86 | 76.10, 132.70, 124.64 | 7/7/5 | 6/6/0 |

D1 query work consistently decreases, but HTTP latency does not consistently improve. Hall has a slightly higher candidate median of round medians (42.03 versus 40.73 ms); the other four routes have lower medians of round medians. Individual rounds and tails still vary substantially, including a slower candidate MCP Hall third round. CSV is buffered only by the observation wrapper, so these are completed-body times, not first-byte/streaming latency. No cloud RTT, billing or larger-dataset claim follows from this small local snapshot.
