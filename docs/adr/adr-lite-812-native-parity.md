# ADR-lite: native and full-facade performance evidence (#812)

Status: implemented; local gates passed. The deployment report and per-block
budget verdicts are maintained in [PR #821](https://github.com/aotter/mantle/pull/821).

The existing HTTP harness now records TTFB and full-body timing separately,
response bytes, and bounded concurrent arrivals. `pnpm bench:wrangler` keeps the
old row/query regressions and adds a native smoke matrix. `pnpm bench:parity`
runs the larger matrix, real Better Auth PKCE/OTP/consent/JWT/DPoP issuance,
revocation/role/replay denials, prepared D1 across fresh workerd processes, and
R2 transfers. No token, cookie, proof, user ID, SQL, argument or object key enters
the diagnostic record. Only the secret-protected synthetic fixture has control
endpoints; never bind it to a consumer database or bucket.

## Controls and boundaries

| Layer | Work |
|---|---|
| F0 | Fixed fetch response; standalone `floor-worker.ts` measures module/bundle floor. R2 F0 performs HEAD only. |
| F1 | Hono + native SQL and the same public payload; no authentication. |
| F2 | Native Worker, shared real Auth/session/consent/fresh-role/DPoP checks, SQL compiler and validators, response envelope. MCP shares protocol dispatch and View execution; unmeasured mutations fail closed. |
| M | Full `createMantleWorker`, same sealed plan, bindings, data and security policy. R2 uses the production storage commit adapter directly. |

Protected parity is F2/M. The View and catalog response bodies must match, drafts
stay private, and auth/protocol errors must fail correctly. Procedure input errors
compare status/code, not complete diagnostic wording. Admin/Web are facade coverage,
not a matched-native claim. R2 measures native stream metadata commits and failure/
retry; D1 MediaAsset publication is covered by the separate #810 integration test.
The shared comparison bundle intentionally keeps dependencies/configuration equal;
it cannot measure the difference between standalone application bundle sizes.

The planner runs outside workerd. Route/Schema/View axes each use 1/10/100/1,000;
extra Schemas are unindexed to keep the index-count axis fixed. D1 has a 100-column
limit, including generated index columns, so this is not a claim that 1,000 indexed
Schemas fit one entries table. Body/row axes use 64 B/4 KiB and 100/10,000/50,000;
locales use 1/3/10, MCP client concurrency uses 1/4/8, R2 uses 1/3/12 variants at
1/64/256 KiB. Actual simultaneous arrivals can be below client concurrency. The remote fleet
can add isolates during a batch. A request is repeat-in-isolate only after that
exact workload previously completed there; overlapping first arrivals stay in
the first-for-workload cohort. Two global warmups alone cannot prove a warm fleet.
First requests retain their raw records and a bounded extra-six-statement setup
allowance; repeat MCP requests must meet the exact two/three/four-statement gate.
Parity summaries use repeat cohorts; first-for-workload does not necessarily mean
cold module startup (another workload may already have used that isolate).

## Stable gates and measured signals

- Indexed public View: one statement and at most 100 available rows read at every
  tested data size. MCP catalog: two statements (grant + fresh role), one KV GET;
  View: three statements with Bearer, four with native DPoP replay reservation.
- Selected Trigger: four segment lookups at every route count in the portable
  regression; native last-route requests retain one statement at 1,000 routes.
- Public HTML/llms: two warm statements and less than 1 MiB selected JSON. Sitemap
  index remains explicit O(N) metadata work to enumerate complete part links.
- R2: exactly N GET + N PUT, known full-body bytes, at most three transfers in
  flight; a first-batch failure starts no later batch and a retry succeeds.
- Fixture HTTP bodies at most 2 MiB; inspector heap after each batch at most
  96 MiB. This is an observed JS heap ceiling, not instantaneous peak memory or
  retained-after-GC heap. Custom application templates retain their own limits.

The default fixture bundle gate is 4,500 KiB raw / 800 KiB gzip (measured
3,699.93 / 647.98 KiB). The standalone F0 is 0.52 / 0.34 KiB; a 1,000-route
fixture is 4,051.18 / 668.60 KiB. Larger manifest-axis builds are reported
separately. Module startup profiles are a local diagnostic; actual deployed
startup must remain below the provider limit and is recorded during acceptance.

No cross-machine latency gate is used. CDP batch samples estimate local active JS
(including warmup); they are not per-request or billing CPU. Native Tail CPU/wall
are correlated by random request ID only in remote runs; unavailable timing stays
null. D1 metadata sums cover only `metadataStatements`; native Auth `.first()` does
not return rows/duration, and zero cannot substitute for that missing coverage.

The 2026-09-08 full local run contained 2,697 measured requests / 144 cases, no
unexpected HTTP status, max response 84,185 B, and max observed heap 67,103,480 B.
The observed F2/M p50 full-body delta for the 50k-row/4KiB View was -0.347 ms
(95% within-run bootstrap interval [-0.727, 0.128]); MCP catalog +0.903 ms
[0.470, 1.070]; Bearer MCP View -0.578 ms [-1.235, 0.329]. These are localhost
measurements, not a remote parity conclusion. Ten orthogonal route/Schema/View
runs and both extra locale runs also passed. Self-review corrected a fixture that
accidentally scaled indexes with Schemas, an English-only page assertion in the
multilingual fixture, and missing D1 metadata incorrectly summarized as zero.

## Remote difference budget (calibrated 2026-09-08)

The first complete off-a block (05:44:20–05:57:16 UTC, SDK 1798e78) contains
1,385 requests with 100% native CPU coverage, 46 first-for-workload arrivals and
no unexpected status failures. Public cache returned MISS then HIT; the HIT
had no invocation record. Warm F2/M CPU medians match at 0 ms health, 2 ms View,
1 ms Procedure, 2 ms MCP catalog and 3 ms Bearer MCP View. DPoP medians differ
by 0–1 ms; the largest within-run CPU delta upper interval is 2 ms. One hundred
requests per layer/diagnostics mode measure roughly +1 ms median CPU for the
collector itself on both layers. This is native millisecond-resolution telemetry.

Freeze this initial budget before evaluating the on-a/off-b/on-b blocks:

- At least 20 repeat-in-isolate samples per layer, equivalent successful payloads
  and current authorization checks; expected denial cases are functional gates.
- Upper 95% bootstrap interval for M minus F2 median platform CPU: at most 2 ms.
- Upper 95% bootstrap interval for M minus F2 median full-body latency: at most
  max(15 ms, 5% of the paired F2 median). Compare consistent placement contexts;
  report changes in ingress/execution placement separately.
- Exact warm statement/binding budgets and zero unexpected outcomes still apply.
  Latency/CPU differences are a matched deployment acceptance budget, not an
  absolute cross-machine CI timer gate. First-for-workload records stay visible;
  the budget makes no blanket claim about cold setup or all native workloads.

## Reproduction and remote acceptance

Run from the repository root with built workspace dependencies:

```sh
pnpm bench:wrangler
pnpm bench:parity
BENCH_ROUTES=1000 BENCH_CASES=scaling pnpm bench:parity
BENCH_SCHEMAS=1000 BENCH_CASES=scaling pnpm bench:parity
BENCH_VIEWS=1000 BENCH_CASES=scaling pnpm bench:parity
BENCH_LOCALES=en,fr,de BENCH_QUICK=1 pnpm bench:parity
node scripts/summarize-wrangler-parity.mjs /path/to/report.json
```

For remote acceptance, provision dedicated synthetic D1/KV (R2 when enabled),
put a random 32+ character BENCHMARK_KEY secret, and deploy the fixture with
BENCH_REMOTE_RECORDS=1. Run with BENCH_ORIGIN, BENCHMARK_KEY, BENCH_ACCOUNT_ID,
BENCH_PROFILE_NAME, BENCH_BLOCK and BENCH_PLACEMENT in the process environment.
The runner uses Wrangler's existing named-profile authentication to open the
same native trace-v1 API used by `wrangler tail`. It retains only the nonce-
correlated diagnostic fields and native CPU/wall timing in memory, never request
headers/body/URL, credentials or unrelated logs. The tail session is deleted at
completion. No paid Tail Worker, sink database writes or elevated log API token
is needed. Off-mode records also correlate platform CPU to measure overhead.

PHSU has no R2 subscription; its remote run uses BENCH_SKIP_R2=1. R2 coverage
comes from native workerd, with no remote R2 latency claim. A paid Tail Worker
attempt was rejected by the provider, then replaced by the verified real-time API.

Alternate off/on/off/on deployment blocks and BENCH_ORDER=reverse for the second
pair. Record actual placement status, request `cf-placement` when supplied,
ingress colo, deployment version, SDK/Wrangler/compatibility date, sampling window
and errors. Origin timings force private/no-store; a separate probe requires a
real public MISS followed by HIT with no invocation record. Local runs never
invent HITs. A deployed Worker with existing D1 is labeled deployment-first.

Use `wrangler deploy --dry-run --outfile <bundle>` followed by
`wrangler check startup --worker <bundle> --outfile <profile>` for module startup.
Record standalone F0, the full fixture and the actual packed consumer separately.
Set the remote F2/M CPU/latency difference budget after collecting the baseline,
then evaluate repeated blocks with bootstrap intervals, explaining shared-host
and cross-request correlation. Smart Placement provisioning belongs to #803;
INSUFFICIENT_INVOCATIONS is not evidence of a placement latency improvement.
