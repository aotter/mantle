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

The actual unchanged application also runs in local Wrangler before/after with matched official Auth peers (1.7.7) and Core/UI versions. Hall, report, Admin bootstrap, complete CSV and MCP Hall responses match byte for byte; anonymous guards remain enforced. HTTP timing evidence follows below. Private snapshots, row hashes and raw responses remain outside the public repository.

Three quiet HTTP rounds per variant use five warmups and thirty measured requests per route: 900 measured authenticated responses total. The exact complete-body hashes match across every variant/sample without normalization. Times include local HTTP, synthetic authentication, workerd, D1 and reading the complete response body.

| Route | Before round p50 ms | After round p50 ms | Before round p95 ms | After round p95 ms | Before D1 calls/statements/batches | After D1 calls/statements/batches |
|---|---|---|---|---|---|---|
| hall | 37.13, 33.89, 36.19 | 39.56, 29.50, 33.06 | 73.03, 101.57, 104.88 | 58.51, 37.45, 101.41 | 9/9/5 | 7/7/0 |
| report | 20.01, 17.10, 20.34 | 16.08, 29.85, 19.21 | 29.58, 25.00, 45.67 | 20.95, 39.97, 44.65 | 7/7/5 | 6/6/0 |
| admin:bootstrap | 12.13, 10.43, 11.13 | 12.39, 12.06, 11.73 | 20.80, 14.16, 25.54 | 25.09, 27.34, 19.56 | 3/3/1 | 2/2/0 |
| admin:csv | 13.29, 10.86, 12.17 | 16.14, 11.07, 10.88 | 26.08, 13.91, 31.48 | 24.01, 19.59, 22.20 | 3/3/1 | 2/2/0 |
| mcp:hall | 31.45, 33.63, 30.47 | 62.03, 38.53, 31.81 | 77.14, 68.70, 36.73 | 104.75, 69.75, 66.44 | 7/7/5 | 6/6/0 |

D1 query work consistently decreases, but HTTP latency does not consistently improve. MCP Hall is slower in these candidate samples; Admin bootstrap also has a higher median of round medians. CSV is buffered only by the observation wrapper, so these are completed-body times, not first-byte/streaming latency. No cloud RTT, billing or larger-dataset claim follows from this small local snapshot.
