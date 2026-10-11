# Acceptance goals

- [x] Bare native query: driver-native parameters, rows and errors; no validators, JSON scans or generic row/error normalization.
- [x] Actual v2 manifests compile with the existing parser/linker/policy/printers; four targets generate typed functions with literal SQL.
- [x] Generated request bundles have no old Mantle engine/compiler dependency; strict dependency direction is checked automatically.
- [x] Offline Wrangler bundle gate (whole fixture API, official PG driver), selected-operation scaling and package file/size gates.
- [x] Scope/auth/OCC, native atomic rollback and error outcomes verified against native implementations on all four real engines/hosts.
- [x] Declared date-time/date wire form tested; unsupported contracts fail generate.
- [ ] Paging/cursor API compatibility (open).
- [ ] Workers startup CPU and first-use regression gates; native performance acceptance with retained raw samples.

Completing this increment does not migrate all 0.2 modules: the
[compatibility ledger](../../docs/next/compatibility.md) decides readiness to replace it.
