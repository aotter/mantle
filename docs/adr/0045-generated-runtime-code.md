# ADR-0045: Generated runtime code for plan-derived work

**Status:** Proposed for #1447. Fingerprint and reader-shape decisions await the operator's explicit choice; other items preserve ADR-0044's existing trust boundary.

**Date:** 2026-10-11

**Amends:** ADR-0044. Reader seeds, when accepted, also amend ADR-0043 decision 4.

## Context

Generate already knows the sealed plan, dialect, bind recipes and output columns. Reinterpreting them at boot or per value is work that the native application does not need. Moving that work into module initialization would retain the cold-isolate cost. The accelerator must emit ordinary code or constants, with no runtime eval and no additional database resource management.

## Decision

1. `mantle generate` emits `runtime.ts` alongside `plan.json` and `mantle.ts`; `--check` compares every output byte for byte. `mantle.ts` registers its imported runtime artifacts against the exact exported plan object. Registration is a WeakMap insertion, not whole-plan compilation, validator construction or cache seeding. Runtime acquires artifacts once, then passes functions into existing execution seams.
2. Registration is application code, not evidence that an uploaded plan is trustworthy. Generated artifacts record the plan fingerprint, running Mantle version and full lowering dialect identity/key. A mismatch, restricted dialect, absent printer, or any supplied `expectedFingerprint` disables them. Uploaded plans retain fingerprint verification and existing `verifyPlan`/restrict obligations. A plan copied to another object has no registration. There is no alternate trust inference from JSON fields.
3. The generated module is optional. Missing or incompatible artifacts use current paths: first-use construction cached per plan, never whole-plan global construction. Public handwritten runtime/Store usage remains supported. Runtime has no import of a concrete driver or dialect package.
4. Printed `preRead` and lock-version `one` statements remain plan data, use the canonical dialect printer, and are re-derived by `verifyPlan`. Row-locking/version predicates, lifecycle ordering, refusal behavior and transaction boundaries remain unchanged. Unsupported statements fall back.
5. Generated per-View row functions combine projection, declared-name renames and necessary dialect conversion in one pass. Hidden paging keys remain available only for cursor construction. Unknown output shapes fall back. Safe own-property semantics, including `__proto__`, duplicate output/rename behavior and native JSON/date/numeric conversions remain identical.
6. Generated bind functions resolve the same recipe in the same order, using typed dialect encoders. Caller identity, time, version and dynamic values remain invocation arguments. Permissions are never frozen from one caller. Input folding, cursor and pagination sources, defaults, errors and native codec differences must match the existing path.
7. Standalone schema validators are emitted only for constructs for which differential tests prove exact current behavior: result/default/unknown-key behavior and first diagnostic pointer/message, including JSON safety bounds. Unsupported schemas use existing lazy validators. No change to the validation contract is hidden in a performance PR.
8. Common reader and staff-list shapes may be generated as bounded constants, never eagerly compiled or copied into every runtime memo. Reader seed adoption requires the pending ADR-0043 decision. Other dynamic shapes preserve current first-use behavior and bounded memo rules.
9. MCP configuration and boot lookup tables may be emitted or retained on first use where measurements justify it. Authentication, authorization, transports and native storage still own their existing responsibilities. No pools, scheduling, retries or cross-database consistency layer are introduced.

### Pending fingerprint choice

Only explicitly registered bundled code can assert its generated fingerprint in place of a boot hash, subject to decision 2. This changes detection of application-side mutation after generation: the deployment owner is responsible for preserving its bundle. Before enabling it, the operator must accept this boundary. If rejected, boot hashing remains for all plans; other generated execution artifacts do not depend on skipping it.

## Delivery and validation

Each work item in #1447 has a coherent PR and measured result. First implement fingerprint registration (subject to the choice), Procedure lowering, row functions and binders. Measure those before choosing the next expensive work. Dependencies are explicit; PRs target develop and remain unmerged until reviewed.

For each accelerator test generated and fallback paths against the same values and native codecs, including failures. Test disabled gates and generate/check staleness. Run required package checks, packed consumers and local Wrangler benchmarks. Benchmark before/after on the same machine without competing jobs, cold import/boot/first invocation separately from warm calls. Report generated size and any regressions; do not declare native parity while a measured gap remains.

Full HTTP native comparisons include the same authentication, business behavior and transport. Exact-SQL replay isolates driver-versus-wrapper costs but is not a whole native application. Elapsed time outside driver calls is not automatically pure Core CPU; nested/parallel timings and percentile medians are not additive.

## Alternatives

- Whole-plan module initialization: retains cold cost; rejected by ADR-0044.
- Runtime eval/JIT: unavailable on Workers and unnecessary for build-time code.
- Second printer, codec or validation semantics: creates duplicate owners; use existing dialect implementations and differential tests.
- New resource/cache manager: unrelated to plan-derived work; existing plan identity, compile/paging caches and reader memo remain the ownership boundaries.
