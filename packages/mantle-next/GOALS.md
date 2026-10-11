# Acceptance goals

- [x] Generate actual v2 manifests using the existing parser/linker/policy/printers.
- [x] All four targets generate typed functions with literal SQL and native calls.
- [x] Generated request bundle has no old Mantle engine/compiler dependency.
- [ ] Supported SQL-slice scope/auth/input/output behavior verified against native implementations.
- [ ] Native atomic rollback, explicit OCC and error outcomes verified on each target.
- [ ] Paging/cursor API compatibility completed (open); scalar codecs tested and unsupported contracts fail generate.
- [ ] Four real local applications run side by side; raw paired timing evidence retained.
- [ ] Cold-start and warm work budgets measured honestly, without benchmark-only paths.
- [x] Strict dependency direction checked automatically.
- [ ] Correctness and Ponytail reviews addressed; full check outcome recorded.

Completion of this first increment does not imply all 0.2 modules are migrated.
The compatibility inventory and measured results determine readiness to replace it.
