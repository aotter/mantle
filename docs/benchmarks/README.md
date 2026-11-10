# Benchmarks and local evidence

Local measurements behind performance and runtime-shape decisions. None of them is a production, Cloudflare or latency
claim; each says what it ran on.

| document | what it shows |
|---|---|
| [Runtime overhang baseline](runtime-overhang-baseline.md) | Warm and cold Mantle cost over the SQL it sends, with call counters, on develop before #1432 and #1433. Produced by the harness below; raw numbers in [`data/`](data/). |
| [Native driver cleanup](native-driver-cleanup.md) | Local evidence for the native driver cleanup. |
| [Native query cleanup](native-query-cleanup.md) | Local evidence for the native query cleanup (#1428, ADR-0042). |
| [Application native cleanup](application-native-cleanup.md) | The same cleanup measured against an application workload. |

## The harness

`pnpm bench` runs the native four-target conformance suite with its bare and external read benchmarks
(`packages/mantle/scripts/verify-native.ts --bench`). It refuses to run unless `MANTLE_NEXT_QUIET_SLOT=1` and the
checkout is committed and clean, and it prints one JSON line per target. It is contributor tooling and ships nothing.

```bash
pnpm build
MANTLE_NEXT_QUIET_SLOT=1 pnpm bench
```

The documents above that cite `packages/mantle/bench/` were produced by an earlier harness that has since been removed.

To commit evidence, save the JSON under `docs/benchmarks/data/` named after the commit it measured, and keep the
environment header and the no-production caveat in the document that quotes it.
