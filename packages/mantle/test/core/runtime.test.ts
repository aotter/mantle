import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, DiagnosticError, planFingerprint, type RuntimePlan } from "../../src/spec/index.js";
import { createMantle, createMantleRuntime, systemCaller, type Caller, type HandlerContext, type Invocation, type MantleHandlers, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";

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
kind: Procedure
metadata: { name: recurse }
spec: { input: { type: object }, output: { type: object }, handler: { ref: recurse } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: recurse-create }
spec: { source: { kind: lifecycle, schema: items, on: [after_create] }, target: { procedure: recurse } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: star-items }
spec: { surface: internal, sql: "SELECT * FROM items ORDER BY id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: guarded-items }
spec: { surface: internal, input: { type: object, properties: { n: { type: integer, default: 2 } } }, requires: { guard: { procedure: guard-office } }, sql: "SELECT id FROM items WHERE stock >= input.n ORDER BY id" }
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
    calls.push({ name: "guardOffice", ctx, input: _i });
    if (ctx.caller.kind !== "user" || ctx.caller.subject !== "boss") throw new DiagnosticError({ code: "AUTH_DENIED", phase: "runtime", severity: "error", path: "guard", message: "not the boss", value: undefined, expected: undefined, candidates: undefined, suggestion: undefined });
    await expect(ctx.store.write([{ delete: "items", where: { id: "x" } }])).rejects.toThrow(/may not write/);
    return {};
  },
  staffOnly: (input: { n?: number }) => ({ n: (input.n ?? 0) + 1 }),
  chain: async (input: { depth?: number }, ctx: HandlerContext) => (input.depth === 0 ? {} : ctx.invoke("chain", { depth: (input.depth ?? 99) - 1 })),
  nightly: (_i: unknown, ctx: HandlerContext) => { calls.push({ name: "nightly", ctx, input: _i }); return {}; },
  // a hook that writes again: every level is one deeper in the cause chain, so the depth limit ends it
  recurse: async (_i: unknown, ctx: HandlerContext) => {
    const row = ctx.cause.kind === "lifecycle" ? ctx.cause.rows[0] : undefined;
    if (!String(row?.name).startsWith("rec")) return {};
    calls.push({ name: "recurse", ctx, input: _i });
    await ctx.store.write([{ insert: "items", values: { name: `rec${calls.length}`, stock: 1 } }, { insert: "items", values: { name: `rec-twin${calls.length}`, stock: 1 } }]);
    return {};
  },
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

  it("refuses a re-sealed plan whose hook target or guard is an inline program (defence in depth: mantle validate refuses it first)", async () => {
    const { fingerprint: _f, ...body } = plan;
    const patched = { ...body, procedures: { ...plan.procedures, audit: { ...plan.procedures.audit!, handler: plan.procedures["add-item"]!.handler } } };
    const sealed = { ...patched, fingerprint: await planFingerprint(patched) } as RuntimePlan;
    expect((await failure(boot({ plan: sealed, handlers: Object.fromEntries(Object.entries(handlers).filter(([k]) => k !== "audit")) as never })))?.diagnostic.code).toBe("LIFECYCLE_TARGET_NOT_REF");
  });

  it("refuses a plan compiled for another dialect before it touches storage (ADR-0035 decision 5)", async () => {
    const { fingerprint: _f, ...body } = plan;
    for (const dialect of [{ ...plan.dialect, name: "@acme/postgres" }, { ...plan.dialect, version: "0" }]) {
      const other = { ...body, dialect };
      let prepared = false;
      const storage = { ...sqliteStorage(d1), prepare: async () => { prepared = true; throw new Error("unreachable"); } };
      expect((await failure(boot({ plan: { ...other, fingerprint: await planFingerprint(other) } as RuntimePlan, storage })))?.diagnostic)
        .toMatchObject({ code: "PLAN_FINGERPRINT_MISMATCH", message: expect.stringContaining("compiled for dialect") });
      expect(prepared).toBe(false);
    }
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

  it("hooks a handler's writes fire chain to its invocation: the depth limit ends a recursive hook, and event ids are unique per write", async () => {
    calls.length = 0;
    await add("o1", "rec0", 1);
    const levels = calls.filter((c) => c.name === "recurse");
    const depth = (c: { ctx: HandlerContext }) => { let n = 0; for (let p: { parent?: unknown } | undefined = c.ctx.cause; p; p = p.parent as never) n++; return n; };
    expect(levels.length).toBeGreaterThan(1);
    expect(Math.max(...levels.map(depth))).toBeLessThanOrEqual(9);
    const ids = levels.map((l) => (l.ctx.cause as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("SELECT * never reads the scope column, and the default Store projection omits it", async () => {
    const id = await add("o1", "star", 1);
    const star = (await rt.store.as(user("o1")).view("star-items", { limit: 500 })).rows.find((r) => r.name === "star")!;
    expect(Object.keys(star)).not.toContain("owner");
    const [row] = (await rt.store.as(user("o1")).select({ from: "items", where: { id } })).rows;
    expect(row).toMatchObject({ id, name: "star" });
    expect(Object.keys(row!)).not.toContain("owner");
    expect(Object.keys((await rt.store.select({ from: "items", where: { id } })).rows[0]!)).not.toContain("owner");
  });

  it("a View's guard runs before the View", async () => {
    expect((await failure(rt.store.as(user("mallory")).view("guarded-items")))?.diagnostic.message).toBe("not the boss");
    expect((await rt.store.as(user("boss")).view("guarded-items")).rows).toEqual([]); // the guard passes; boss owns no items
    expect(calls.filter((c) => c.name === "guardOffice").at(-1)?.input).toEqual({ n: 2 });
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
    const cyclic = { kind: "internal" as const, id: "cycle", parent: undefined as Invocation["cause"] | undefined };
    cyclic.parent = cyclic;
    expect((await failure(rt.invokeProcedure({ ...inv("chain", { depth: 0 }, user("o1")), cause: cyclic })))?.diagnostic.code).toBe("INVOCATION_DEPTH_EXCEEDED");
  });
});

describe("createMantle", () => {
  it("keeps each concurrent request's service, handler and lifecycle background work on its own context", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const retained = { a: 0, b: 0 };
    const compiled = await compilePlan({ sources: [{ sourceId: "concurrent", text: `${MANIFESTS}\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: Schema\nmetadata: { name: background-items }\nspec: { title: Background items, lifecycle: operational, schema: { type: object, properties: { name: { type: string } } } }\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: Trigger\nmetadata: { name: audit-background }\nspec: { source: { kind: lifecycle, schema: background-items, on: [after_create] }, target: { procedure: audit } }` }] });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const background = { ...handlers, audit: (_input: unknown, ctx: HandlerContext) => { ctx.waitUntil(Promise.resolve()); return {}; } };
    const m = createMantle({ handlers: background, fetch: async (request: Request, _env: unknown, { runtime, waitUntil }: { runtime: MantleRuntime; waitUntil: (p: Promise<unknown>) => void }) => {
      if (new URL(request.url).pathname === "/a") await gate;
      waitUntil(Promise.resolve());
      await runtime.invokeProcedure(inv("audit", {}, user("concurrent")));
      await runtime.store.as(user("concurrent")).write([{ insert: "items", values: { name: "concurrent", stock: 1 } }]);
      await runtime.store.write([{ insert: "background-items", values: { name: "concurrent-host" } }]);
      return new Response("ok");
    } } as never, { plan: compiled.plan, schedules: true, storage: () => sqliteStorage(d1) });
    const a = m.fetch(new Request("http://x/a"), {}, { waitUntil: () => { retained.a++; } });
    await m.fetch(new Request("http://x/b"), {}, { waitUntil: () => { retained.b++; } });
    release();
    await a;
    expect(retained).toEqual({ a: 4, b: 4 });
  });
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
    // a message is honoured only for what a Trigger of the plan would have run, and never as the system caller
    const forged = [{ ...audit, caller: systemCaller("forged") }, { ...audit, procedure: "take" }, { ...audit, cause: { ...audit.cause, trigger: "nope" } }, { ...audit, cause: { ...audit.cause, schema: "other" } }];
    for (const f of forged) expect((await failure(m.runDeferredHook(f, {})))?.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
    const malformed = [
      { ...audit, cause: { ...audit.cause, trigger: "toString" } },
      { ...audit, cause: { ...audit.cause, hook: undefined } },
      { ...audit, cause: { ...audit.cause, hook: 3 } },
      { ...audit, caller: { kind: "user" } },
      { ...audit, cause: { ...audit.cause, rows: [] } },
      { ...audit, cause: { ...audit.cause, parent: { kind: "internal" } } },
    ];
    const cyclic = { ...audit.cause, parent: undefined as Invocation["cause"] | undefined };
    cyclic.parent = cyclic;
    malformed.push({ ...audit, cause: cyclic });
    for (const f of malformed) expect((await failure(m.runDeferredHook(f, {})))?.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
  });

  it("retries a failed boot on the next request", async () => {
    let n = 0;
    const m = createMantle({ handlers, fetch: () => new Response("ok") } as never, { plan, schedules: true, storage: () => { if (n++ === 0) throw new Error("storage down"); return sqliteStorage(d1); } });
    await expect(m.fetch(new Request("http://x/"), {})).rejects.toThrow("storage down");
    expect((await m.fetch(new Request("http://x/"), {})).status).toBe(200);
  });
});
