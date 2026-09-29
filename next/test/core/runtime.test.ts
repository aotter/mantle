import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, DiagnosticError, type RuntimePlan } from "../../src/spec/index.js";
import { createMantle, createMantleRuntime, systemCaller, type Caller, type HandlerContext, type Invocation, type MantleHandlers, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/core/sql/adapter.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: items }
spec:
  title: Items
  lifecycle: operational
  scope: { owner: auth.uid() }
  indexes: [[owner]]
  checks: ["stock >= 0"]
  schema:
    type: object
    required: [owner]
    properties: { owner: { type: string }, name: { type: string }, stock: { type: integer } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: add-item }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [name, stock], properties: { name: { type: string }, stock: { type: integer } } }
  output: { type: object, required: [results] }
  handler: { sql: "INSERT INTO items (name, stock) VALUES (input.name, input.stock) RETURNING id, name" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: take }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [id, qty], properties: { id: { type: string }, qty: { type: integer } } }
  output: { type: object, required: [results] }
  handler: { sql: "UPDATE items SET stock = stock - input.qty WHERE id = input.id RETURNING id, stock" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: rename }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [id, name], properties: { id: { type: string }, name: { type: string } } }
  output: { type: object, required: [results] }
  handler: { sql: "UPDATE items SET name = input.name WHERE id = input.id RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: audit }
spec:
  input: { type: object }
  output: { type: object }
  handler: { ref: audit }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: no-locked }
spec:
  input: { type: object }
  output: { type: object }
  handler: { ref: noLocked }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: audit-create }
spec: { source: { kind: lifecycle, schema: items, on: [after_create] }, target: { procedure: audit } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: guard-rename }
spec: { source: { kind: lifecycle, schema: items, on: [before_update] }, target: { procedure: no-locked } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: staff-only }
spec:
  requires: { auth: { all: [{ ctx.staff: [owner] }] }, guard: { procedure: guard-office } }
  input: { type: object, properties: { n: { type: integer } } }
  output: { type: object, required: [n] }
  handler: { ref: staffOnly }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: guard-office }
spec:
  input: { type: object, properties: { n: { type: integer } } }
  output: { type: object }
  handler: { ref: guardOffice }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: chain }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object }
  output: { type: object }
  handler: { ref: chain }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: nightly }
spec:
  input: { type: object }
  output: { type: object }
  handler: { ref: nightly }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: nightly-run }
spec: { source: { kind: schedule, cron: "0 3 * * *" }, target: { procedure: nightly } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: my-items }
spec:
  surface: internal
  requires: { auth: { all: [ctx.user] } }
  sql: "SELECT id, name, stock FROM items ORDER BY name"
`;

const user = (subject: string, role: "owner" | null = null): Caller => ({ kind: "user", subject, role, scopes: [], credential: "session", credentialId: null, clientId: null });
const inv = (procedure: string, input: unknown, caller: Caller, id = "t"): Invocation => ({ procedure, input, caller, cause: { kind: "http", id } });
const code = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) instanceof DiagnosticError ? undefined : undefined;
const failure = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) as DiagnosticError | undefined;

let plan: RuntimePlan;
let d1: LocalD1;
const calls: { name: string; ctx: HandlerContext; input: unknown }[] = [];
const handlers: MantleHandlers<never> = {
  audit: (input: unknown, ctx: HandlerContext) => {
    calls.push({ name: "audit", ctx, input });
    if (ctx.cause.kind === "lifecycle" && ctx.cause.rows[0]?.name === "boom") throw new Error("after hook fails");
    return {};
  },
  noLocked: async (input: unknown, ctx: HandlerContext) => {
    calls.push({ name: "noLocked", ctx, input });
    const row = ctx.cause.kind === "lifecycle" ? ctx.cause.rows[0] : undefined;
    if (row?.name === "locked") throw new DiagnosticError({ code: "LIFECYCLE_HOOK_REJECTED", phase: "runtime", severity: "error", path: "hook", message: "locked", value: undefined, expected: undefined, candidates: undefined, suggestion: undefined });
    await expect(ctx.store.write([{ delete: "items", where: { id: "x" } }])).rejects.toThrow(/may not write/);
    await expect(ctx.invoke("audit", {})).rejects.toThrow(/may not invoke/);
    return {};
  },
  guardOffice: async (_i: unknown, ctx: HandlerContext) => {
    if (ctx.caller.kind !== "user" || ctx.caller.subject !== "boss") throw new DiagnosticError({ code: "AUTH_DENIED", phase: "runtime", severity: "error", path: "guard", message: "not the boss", value: undefined, expected: undefined, candidates: undefined, suggestion: undefined });
    await expect(ctx.store.write([{ delete: "items", where: { id: "x" } }])).rejects.toThrow(/may not write/);
    return {};
  },
  staffOnly: (input: { n?: number }) => ({ n: (input.n ?? 0) + 1 }),
  chain: async (input: { depth?: number }, ctx: HandlerContext) => (input.depth === 0 ? {} : ctx.invoke("chain", { depth: (input.depth ?? 99) - 1 })),
  nightly: (_i: unknown, ctx: HandlerContext) => { calls.push({ name: "nightly", ctx, input: _i }); return {}; },
} as never;

beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:test", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  plan = res.plan;
  d1 = await LocalD1.create();
}, 60_000);
afterAll(() => d1.dispose());

const boot = (over: Partial<Parameters<typeof createMantleRuntime>[0]> = {}) =>
  createMantleRuntime({ plan, handlers, storage: sqliteStorage(d1), schedules: true, ...over });

describe("boot", () => {
  it("refuses a plan that changed after it was sealed, a wrong expected fingerprint, and unmatched handlers", async () => {
    const tampered = { ...plan, schemas: { ...plan.schemas, items: { ...plan.schemas.items!, ttl: "x" } } } as RuntimePlan;
    expect((await failure(boot({ plan: tampered })))?.diagnostic).toMatchObject({ code: "PLAN_FINGERPRINT_MISMATCH", message: expect.stringContaining("changed after it was sealed") });
    expect((await failure(boot({ expectedFingerprint: "0".repeat(64) })))?.diagnostic.code).toBe("PLAN_FINGERPRINT_MISMATCH");
    const { audit: _drop, ...missing } = handlers as Record<string, unknown>;
    expect((await failure(boot({ handlers: missing as never })))?.diagnostic).toMatchObject({ code: "HANDLER_NOT_REGISTERED", candidates: expect.any(Array) });
    expect((await failure(boot({ handlers: { ...handlers, extra: () => ({}) } as never })))?.diagnostic.code).toBe("HANDLER_NOT_DECLARED");
    expect((await failure(boot({ schedules: false })))?.diagnostic.code).toBe("SCHEDULE_NOT_WIRED");
  });

  it("refuses to serve while storage has a blocked change, and reports the fingerprint it booted", async () => {
    const other = await LocalD1.create();
    await other.exec("CREATE TABLE items (id TEXT)");
    expect((await failure(boot({ storage: sqliteStorage(other) })))?.diagnostic.code).toBe("STORAGE_TABLE_NOT_OWNED");
    await other.dispose();
    expect((await boot()).bootReport()).toEqual({ fingerprint: plan.fingerprint, coreVersion: "0.2.0" });
  });
});

describe("invokeProcedure", () => {
  let rt: MantleRuntime;
  beforeAll(async () => { rt = await boot(); });
  const add = async (who: string, name: string, stock: number) => ((await rt.invokeProcedure(inv("add-item", { name, stock }, user(who)))) as { results: { id: string }[][] }).results[0]![0]!.id;

  it("denies by predicate (401 for anonymous, 403 for a user), validates input and output, and runs an inline program", async () => {
    expect((await failure(rt.invokeProcedure(inv("add-item", { name: "a", stock: 1 }, { kind: "anonymous" }))))?.diagnostic.code).toBe("UNAUTHENTICATED");
    expect((await failure(rt.invokeProcedure(inv("staff-only", {}, user("boss")))))?.diagnostic.code).toBe("AUTH_DENIED");
    expect((await failure(rt.invokeProcedure(inv("add-item", { name: 1 }, user("o1")))))?.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
    expect((await failure(rt.invokeProcedure(inv("add-item", { name: "a", stock: 1 }, systemCaller("test")))))?.diagnostic.code).toBe("UNAUTHENTICATED");
    const id = await add("o1", "apple", 5);
    expect(await rt.invokeProcedure(inv("take", { id, qty: 2 }, user("o1")))).toEqual({ results: [[{ id, stock: 3 }]] });
    expect((await failure(rt.invokeProcedure(inv("take", { id, qty: 9 }, user("o1")))))?.diagnostic).toMatchObject({ code: "INPUT_VALIDATION_FAILED", message: expect.stringContaining("CHECK items: stock >= 0") });
  });

  it("scopes by the caller: another user's row is a missing row", async () => {
    const id = await add("o1", "mine", 5);
    const e = await failure(rt.invokeProcedure(inv("take", { id, qty: 1 }, user("o2"))));
    expect(e?.diagnostic).toMatchObject({ code: "CONFLICT", conflict: { opIndex: 0, reason: "expect" } });
    expect((await rt.store.as(user("o2")).view("my-items")).rows).toEqual([]);
    expect((await rt.store.as(user("o1")).view("my-items")).rows.map((r) => r.name)).toContain("mine");
    expect((await failure(rt.store.as({ kind: "anonymous" }).view("my-items")))?.diagnostic.code).toBe("UNAUTHENTICATED");
  });

  it("runs lifecycle hooks: after hook with rows and a stable cause id, before hook that can veto and cannot write", async () => {
    calls.length = 0;
    const id = await add("o1", "hooked", 1);
    const a = calls.find((c) => c.name === "audit")!;
    expect(a.ctx.caller).toEqual(user("o1"));
    expect(a.ctx.cause).toMatchObject({ kind: "lifecycle", hook: "after_create", schema: "items", trigger: "audit-create", parent: { kind: "http", id: "t" }, rows: [{ id, version: 1, name: "hooked" }] });
    expect((a.ctx.cause as { id: string }).id).toBe("t:0:after_create:audit-create");
    await rt.invokeProcedure(inv("rename", { id, name: "renamed" }, user("o1")));
    expect(calls.find((c) => c.name === "noLocked")!.ctx.cause).toMatchObject({ hook: "before_update", rows: [{ id, name: "hooked", version: 1 }] });
    const locked = await add("o1", "locked", 1);
    const e = await failure(rt.invokeProcedure(inv("rename", { id: locked, name: "free" }, user("o1"))));
    expect(e?.diagnostic.code).toBe("LIFECYCLE_HOOK_REJECTED");
    expect((await rt.store.as(user("o1")).select({ from: "items", columns: ["name"], where: { id: locked } })).rows).toEqual([{ name: "locked" }]);
  });

  it("a rollback emits no after event, and an after hook that fails leaves the committed result", async () => {
    calls.length = 0;
    expect((await failure(rt.invokeProcedure(inv("add-item", { name: "neg", stock: -1 }, user("o1")))))?.diagnostic.message).toMatch(/CHECK items/);
    expect(calls.filter((c) => c.name === "audit")).toEqual([]);
    const boom = await add("o1", "boom", 1);
    expect(calls.filter((c) => c.name === "audit")).toHaveLength(1);
    expect((await rt.store.as(user("o1")).select({ from: "items", columns: ["id"], where: { id: boom } })).rows).toEqual([{ id: boom }]);
  });

  it("the system caller bypasses scope but not TTL, and satisfies no auth predicate", async () => {
    const id = await add("o7", "system-visible", 1);
    const sys = rt.store.as(systemCaller("maintenance"));
    expect((await sys.select({ from: "items", columns: ["id"], where: { id } })).rows).toEqual([{ id }]);
    expect((await rt.store.as(user("o8")).select({ from: "items", columns: ["id"], where: { id } })).rows).toEqual([]);
  });

  it("runs a guard first with the validated input, read-only, and stops the target when it throws", async () => {
    const boss: Caller = { ...(user("boss", "owner") as Extract<Caller, { kind: "user" }>) };
    expect(await rt.invokeProcedure(inv("staff-only", { n: 1 }, boss))).toEqual({ n: 2 });
    const other = user("other", "owner");
    expect((await failure(rt.invokeProcedure(inv("staff-only", { n: 1 }, other))))?.diagnostic.message).toBe("not the boss");
  });

  it("chains through ctx.invoke and stops at the depth limit", async () => {
    expect(await rt.invokeProcedure(inv("chain", { depth: 3 }, user("o1")))).toEqual({});
    expect((await failure(rt.invokeProcedure(inv("chain", { depth: 20 }, user("o1")))))?.diagnostic.code).toBe("INVOCATION_DEPTH_EXCEEDED");
  });
});

describe("createMantle", () => {
  it("boots lazily once, hands the runtime to the service, runs schedules as the system caller, and accepts a deferred hook", async () => {
    let boots = 0;
    const m = createMantle({ handlers, fetch: async (req: Request, _env: unknown, { runtime }: { runtime: MantleRuntime }) => Response.json(await runtime.invokeProcedure(inv("add-item", { name: new URL(req.url).pathname, stock: 1 }, user("http")))) } as never, {
      plan, schedules: true, storage: () => { boots++; return sqliteStorage(d1); },
    });
    const res = await m.fetch(new Request("http://x/hello"), {});
    await m.fetch(new Request("http://x/again"), {});
    expect([res.status, boots, Array.isArray(((await res.json()) as { results: unknown[] }).results)]).toEqual([200, 1, true]);

    calls.length = 0;
    await m.invokeSchedule("0 3 * * *", 1_000, {});
    await m.invokeSchedule("5 5 * * *", 1_000, {}); // no Trigger for it
    expect(calls.filter((c) => c.name === "nightly").map((c) => [c.ctx.caller, c.ctx.cause])).toEqual([[systemCaller("schedule"), { kind: "schedule", id: "nightly-run:1000", trigger: "nightly-run", cron: "0 3 * * *", scheduledTime: 1000 }]]);

    const audit: Invocation = { procedure: "audit", input: {}, caller: user("o1"), cause: { kind: "lifecycle", id: "e1", trigger: "audit-create", hook: "after_create", schema: "items", rows: [{ id: "i" }] } };
    calls.length = 0;
    await m.runDeferredHook(audit, {});
    expect(calls.map((c) => c.name)).toEqual(["audit"]);
    expect((await failure(m.runDeferredHook({ procedure: "audit" }, {})))?.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
    expect((await failure(m.runDeferredHook({ ...audit, cause: { ...audit.cause, hook: "before_create" } }, {})))?.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
  });

  it("retries a failed boot on the next request", async () => {
    let n = 0;
    const m = createMantle({ handlers, fetch: () => new Response("ok") } as never, { plan, schedules: true, storage: () => { if (n++ === 0) throw new Error("storage down"); return sqliteStorage(d1); } });
    await expect(m.fetch(new Request("http://x/"), {})).rejects.toThrow("storage down");
    expect((await m.fetch(new Request("http://x/"), {})).status).toBe(200);
  });
});
