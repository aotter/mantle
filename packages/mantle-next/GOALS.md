# Acceptance goals

- [x] Generate actual v2 manifests using the existing parser/linker/policy/printers.
- [x] All four targets generate typed functions with literal SQL and native calls.
- [x] Generated request bundle has no old Mantle engine/compiler dependency.
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

Evidence: 32 focused tests / 299 assertions plus strict four-target consumers;
clean `66122a82` passed 84 native semantic checks, repeated during the warm run.
Full `pnpm check` stops at a baseline Cloud helper `plan_stale` mismatch.
Separately, workspace typechecks and the packed Worker consumer passed; the full
UI run remains non-green despite isolated rerun passes. See
[review](../../docs/next/review.md) and [performance](../../docs/next/performance.md).
