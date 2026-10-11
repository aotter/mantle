# Benchmarks and local evidence

Local measurements behind performance and runtime-shape decisions. None of them is a production, Cloudflare or latency
claim; each says what it ran on.

| document | what it shows |
|---|---|
| [Runtime overhang baseline](runtime-overhang-baseline.md) | Warm and cold Mantle cost over the SQL it sends, with call counters, on develop before #1432 and #1433. Produced by the harness below; raw numbers in [`data/`](data/). |
| [Native driver cleanup](native-driver-cleanup.md) | Local evidence for the native driver cleanup. |
| [Native query cleanup](native-query-cleanup.md) | Local evidence for the native query cleanup (#1428, ADR-0042). |
| [Swolhalla native cleanup](swolhalla-native-cleanup.md) | The same cleanup measured against an application workload. |

## The harness

`packages/mantle/bench/` is contributor tooling and ships nothing. Its README has the methodology, the options, the
`--app` contract for measuring another application, and what it does not measure.

```bash
pnpm build
pnpm bench                                    # cold, warm and counters; JSON under packages/mantle/bench/results/
pnpm bench --label pr --json /tmp/pr.json     # one variant per checkout, on one machine
pnpm bench:compare /tmp/develop.json /tmp/pr.json
```

To commit evidence, save the JSON under `docs/benchmarks/data/` named after the commit it measured, and keep the
environment header and the no-production caveat in the document that quotes it.
