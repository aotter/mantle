/**
 * The Step 2 contract cases still unimplemented (next/README.md). Step 3 moves each group into
 * `runStorageConformance({ create })` in src/testing as it is implemented. Group titles cite their source.
 */
import { describe, it } from "vitest";

// Covered elsewhere: Procedure.target inference agrees with Store (test/core/target-inference.test.ts), an inline hook target is rejected (test/spec/compile-plan.test.ts, and at boot in runtime.test.ts); hooks, OCC, rollback and after-hook failure (test/core/runtime.test.ts, the before-hook case), Views and
// pagination (the store case, which also classifies row and set ops and the lock/expect reasons), invocation, auth predicates and depth, plan and boot (test/core/runtime.test.ts).

describe("ADR-0032: caller identity", () => {
  it.todo("two callers with the same upstream id from different issuers cannot read each other's scoped rows");
  it.todo("an invalid credential is 401, never anonymous");
});

// ADR-0034's eight cases run in `runStorageConformance` (src/testing/cases, run on local D1 by
// test/cloudflare/conformance.test.ts): 1 requisition, 2 stock, 3 report-view, 4 before-hook, 6 types,
// 7 policy, 8 search-places. Case 5 (the dialect refusals) is test/spec/sql-compile.test.ts.

describe("README contract sources not covered by an ADR list", () => {
  it.todo("media and site config: upload commit, delete and settings update go through Store and keep scope");
  it.todo("lifecycle: LifecycleStateMachine owns draft, publish, unpublish, archive and published protection (ported content-ops cases)");
});
