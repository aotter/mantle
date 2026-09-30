/**
 * The Step 2 contract cases still unimplemented (next/README.md). Step 3 moves each group into
 * `runStorageConformance({ create })` in src/testing as it is implemented. Group titles cite their source.
 */
import { describe, it } from "vitest";

describe("ADR-0032: atomicity and hooks", () => {
  it.todo("a hook target with an inline program is rejected");
  it.todo("a before hook has no write and no invoke; its rejection applies nothing in the batch");
  it.todo("a concurrent write between a before check and the commit fails on OCC");
  it.todo("a rollback emits no after event");
  it.todo("an after-hook failure leaves the committed result");
  it.todo("a replayed after event carries the same ctx.cause.id");
});

describe("ADR-0032: row-op classification", () => {
  it.todo("{ id } and { id, performedAt: { gte } } are row ops");
  it.todo("{ ownerId } is a set op");
  it.todo("a caller-scoped rewrite of { id } stays a row op");
  it.todo("Procedure.target inference agrees with Store in every case");
  it.todo("a row op that matches nothing is CONFLICT: lock when the version differs, expect otherwise");
});

describe("ADR-0032: caller identity", () => {
  it.todo("two callers with the same upstream id from different issuers cannot read each other's scoped rows");
  it.todo("an invalid credential is 401, never anonymous");
  it.todo("the system caller bypasses scope but not TTL or lifecycle");
  it.todo("a no-identity service boots with no auth package and no auth tables");
});

// ADR-0034's eight cases run in `runStorageConformance` (src/testing/cases, run on local D1 by
// test/cloudflare/conformance.test.ts): 1 requisition, 2 stock, 3 report-view, 4 before-hook, 6 types,
// 7 policy, 8 search-places. Case 5 (the dialect refusals) is test/spec/sql-compile.test.ts.

describe("README contract sources not covered by an ADR list", () => {
  it.todo("Views and pagination: one opaque cursor bound to from and orderBy; limit default 50, max 500");
  it.todo("invocation and auth predicates: every source runs auth, guard, input, handler, output; ctx.invoke re-runs the target's auth and guard; depth 8 fails INVOCATION_DEPTH_EXCEEDED");
  it.todo("plan and boot: expectedFingerprint mismatch refuses to boot; handler refs and the plan agree in both directions; an enabled schedule without schedules refuses");
  it.todo("media and site config: upload commit, delete and settings update go through Store and keep scope");
  it.todo("lifecycle: LifecycleStateMachine owns draft, publish, unpublish, archive and published protection (ported content-ops cases)");
});
