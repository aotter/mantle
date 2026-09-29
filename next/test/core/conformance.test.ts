/**
 * The Step 2 contract as unimplemented cases (next/README.md). Step 3 moves each group into
 * `runStorageConformance({ create })` in src/testing and fills it in. Group titles cite their source.
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

describe("ADR-0034", () => {
  it.todo("1. requisition: CASE value, RETURNING, WHERE id AND cond fails CONFLICT, conditional INSERT SELECT calls the after hook only when it writes");
  it.todo("2. stock: SET stock = stock - input.qty with checks fails oversell through the check trigger");
  it.todo("3. report View: join, GROUP BY/HAVING and a cursor, scope and TTL injected into every joined Schema");
  it.todo("4. before hooks: a row changing between hook and commit is CONFLICT; a set op on a Schema with a before hook is refused");
  it.todo("5. dialect: unknown AST key, OFFSET, non-allowlisted function, $1, RIGHT JOIN, UPDATE FROM, CURRENT_TIMESTAMP, undeclared table, cte named like a Schema and _mantle_* are refused with a source position");
  it.todo("6. types: integer division, numeric sum, microsecond timestamp vs interval, date_trunc across DST match PostgreSQL; non-literal CAST and interval '1 day' are refused");
  it.todo("7. policy: every relation position of the IR hides or protects another owner's, expired and unpublished rows");
  it.todo("8. search and places: trigram and two-character fallback, FTS5 operators matched literally, other owners absent, near() closest K in order");
});

describe("README contract sources not covered by an ADR list", () => {
  it.todo("Views and pagination: one opaque cursor bound to from and orderBy; limit default 50, max 500");
  it.todo("invocation and auth predicates: every source runs auth, guard, input, handler, output; ctx.invoke re-runs the target's auth and guard; depth 8 fails INVOCATION_DEPTH_EXCEEDED");
  it.todo("plan and boot: expectedFingerprint mismatch refuses to boot; handler refs and the plan agree in both directions; an enabled schedule without schedules refuses");
  it.todo("media and site config: upload commit, delete and settings update go through Store and keep scope");
  it.todo("lifecycle: LifecycleStateMachine owns draft, publish, unpublish, archive and published protection (ported content-ops cases)");
});
