# Acceptance goals

- [x] Generate actual v2 manifests using the existing parser/linker/policy/printers.
- [x] All four targets generate typed functions with literal SQL and native calls.
- [x] Generated request bundle has no old Mantle engine/compiler dependency.
- [x] Supported SQL-slice scope/auth/input/output behavior verified against native implementations.
- [x] Native atomic rollback, explicit OCC and error outcomes verified on each target.
- [ ] Paging/cursor API compatibility completed (open); scalar codecs tested and unsupported contracts fail generate.
- [x] Four real local applications run side by side; raw paired timing evidence retained.
- [ ] Cold-start and warm work budgets measured honestly, without benchmark-only paths; positive warm gaps remain under investigation.
- [x] Strict dependency direction checked automatically.
- [x] Correctness and Ponytail reviews addressed; broad-check blocker recorded.

Completion of this first increment does not imply all 0.2 modules are migrated.
The compatibility inventory and measured results determine readiness to replace it.

Evidence: 24 focused tests / 194 assertions plus strict four-target consumers;
first frozen native run passed 84 semantic checks. Re-run native checks after
final source changes. Full `pnpm check` stops at a baseline Cloud helper
`plan_stale` mismatch; later broad stages have not passed by implication.
