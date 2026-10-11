# Acceptance goals

- [ ] Revised default query: native parameter/result/error behavior, without validators, JSON scans or generic row/error normalization.
- [ ] Selected boundary entries preserve external validation/defaults and required transport contracts without entering bare query bundles.
- [ ] Native controls match the revised query contract; separate controls cover selected boundaries.

- [x] Generate actual v2 manifests using the existing parser/linker/policy/printers.
- [x] All four targets generate typed functions with literal SQL and native calls.
- [x] Generated request bundle has no old Mantle engine/compiler dependency.
- [x] Offline Wrangler deployment bundle regression gate for the whole fixture API, including the official PG driver.
- [x] Package distribution file/size gate and selected-operation bundle scaling gate.
- [x] Retained 168-sample local cold baseline, including the failed D1 process CPU watchdog.
- [ ] Workers library global initialization CPU and first-use regression gates; CLI readiness is not library load time.
- [x] Supported SQL-slice scope/auth/input/output behavior verified against native implementations.
- [x] Native atomic rollback, explicit OCC and error outcomes verified on each target.
- [ ] Paging/cursor API compatibility completed (open); scalar codecs tested and unsupported contracts fail generate.
- [x] Four real local applications run side by side; raw paired timing evidence retained.
- [x] Cold-start and warm work measured with retained raw samples and appropriate host clocks.
- [ ] Native performance acceptance: resolve supported positive gaps and measurement uncertainty; see the performance evidence.
- [x] Strict dependency direction checked automatically.
- [x] Correctness and Ponytail reviews addressed; broad-check blocker recorded.

Completion of this first increment does not imply all 0.2 modules are migrated.
The compatibility inventory and measured results determine readiness to replace it.

Evidence: clean `771cc141` passed 37 focused tests / 322 assertions, strict
four-target consumers, 84 native semantic checks and footprint/package gates.
Two independent adversarial reviews found no remaining correctness blockers.
The local D1 cold CPU watchdog failed; native startup acceptance remains open.
Full `pnpm check` stops at a baseline Cloud helper `plan_stale` mismatch.
Separately, workspace typechecks and the packed Worker consumer passed; the full
UI run remains non-green despite isolated rerun passes. See
[review](../../docs/next/review.md) and [performance](../../docs/next/performance.md).
