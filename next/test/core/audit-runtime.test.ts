import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, DiagnosticError, type Diagnostic } from "../../src/spec/index.js";
import { createMantleRuntime, MAX_INVOCATION_DEPTH, sqliteStorage, systemCaller, type Caller, type DatabaseDriver, type HandlerContext, type InvocationCause, type MantleHandlers, type MantleRuntime } from "../../src/core/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: pages }
spec:
  title: Pages
  lifecycle: publishing
  schema: { type: object, required: [slug, headline], properties: { slug: { type: string }, headline: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: page-translations }
spec:
  title: Translations
  lifecycle: publishing
  localized: true
  translates: { parent: pages, on: slug }
  schema: { type: object, required: [slug, locale, headline], properties: { slug: { type: string }, locale: { type: string }, headline: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: counters }
spec:
  title: Counters
  lifecycle: operational
  schema: { type: object, properties: { n: { type: integer }, seenAt: { type: string, format: date-time } } }
  ttl: { field: seenAt, expireAfterSeconds: 60 }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: bump }
spec:
  input: { type: object, required: [id, v], properties: { id: { type: string }, v: { type: integer } } }
  output: { type: object }
  handler: { sql: "UPDATE counters SET n = 1 WHERE id = input.id AND version = input.v" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: noop }
spec: { input: { type: object }, output: { type: object }, handler: { ref: noop } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: first }
spec: { input: { type: object }, output: { type: object }, handler: { ref: first } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: second }
spec: { input: { type: object }, output: { type: object }, handler: { ref: second } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: b-second }
spec: { source: { kind: lifecycle, schema: counters, on: [after_create] }, target: { procedure: second } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: a-first }
spec: { source: { kind: lifecycle, schema: counters, on: [after_create] }, target: { procedure: first } }
`;
const user: Caller = { kind: "user", subject: "u", role: null, scopes: [], credential: "session", credentialId: null, clientId: null };
const ran: string[] = [];
let failFirst = false;
const handlers = {
  noop: () => ({}),
  first: () => { ran.push("first"); if (failFirst) throw new Error("first fails"); return {}; },
  second: () => { ran.push("second"); return {}; },
} as unknown as MantleHandlers<never>;

let rt: MantleRuntime;
let d1: LocalD1;
let down = false;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:audit", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  const driver: DatabaseDriver = { batch: (s) => (down ? Promise.reject(new Error("D1_ERROR: Network connection lost.")) : d1.batch(s)) };
  rt = await createMantleRuntime({ plan: res.plan, handlers, storage: sqliteStorage(driver), now: () => Date.parse("2026-09-30T12:00:00Z") * 1000 });
}, 60_000);
afterAll(() => d1.dispose());

const store = () => rt.store.as(user);
const fail = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e) => e)) as DiagnosticError | undefined)?.diagnostic as Diagnostic | undefined;
const w = async (from: string, values: Record<string, unknown>) => ((await store().write([{ insert: from, values }]))[0] as { id: string }).id;
const setStatus = (from: string, id: string, status: string) => ({ update: from, set: { status }, where: { id } }) as const;

describe("Store and runner agree on the class of a write", () => {
  it("where { and: [{ id }] } is a row op in both: it returns { id, version }", async () => {
    const id = await w("counters", { n: 1 });
    expect(await store().write([{ update: "counters", set: { n: 2 }, where: { and: [{ id }] } }])).toEqual([{ id, version: 2 }]);
  });

  it("an inline program that locks a version says `lock` for another version and `expect` for a missing entry", async () => {
    const id = await w("counters", { n: 1 });
    const call = (id: string, v: number) => rt.invokeProcedure({ procedure: "bump", input: { id, v }, caller: user, cause: { kind: "http", id: "b" } });
    expect((await fail(call(id, 99)))?.conflict).toEqual({ opIndex: 0, reason: "lock" });
    expect((await fail(call("nope", 1)))?.conflict).toEqual({ opIndex: 0, reason: "expect" });
    await call(id, 1);
  });
});

describe("translates", () => {
  it("counts a published parent even when a newer draft shares the key, and refuses to move the parent in the same write", async () => {
    const p1 = await w("pages", { slug: "s", headline: "one" });
    await store().write([setStatus("pages", p1, "published")]);
    await w("pages", { slug: "s", headline: "newer draft" });
    const tr = await w("page-translations", { slug: "s", locale: "zh-TW", headline: "一" });
    const mixed = await fail(store().write([setStatus("pages", p1, "draft"), setStatus("page-translations", tr, "published")]));
    expect(mixed).toMatchObject({ code: "INPUT_VALIDATION_FAILED", message: expect.stringContaining("its own write") });
    await store().write([setStatus("page-translations", tr, "published")]);
  });
});

describe("failures with no answer are not Diagnostics of a refusal", () => {
  it("a dropped connection is OUTCOME_UNKNOWN for a write and RESOURCE_UNAVAILABLE for a read", async () => {
    down = true;
    try {
      expect((await fail(store().write([{ insert: "counters", values: { n: 1 } }])))?.code).toBe("OUTCOME_UNKNOWN");
      expect((await fail(store().select({ from: "counters" })))?.code).toBe("RESOURCE_UNAVAILABLE");
    } finally { down = false; }
  });
});

describe("the system caller, hooks and depth (mutation checks)", () => {
  it("the system caller bypasses scope only: a published entry is still protected, an expired row still invisible", async () => {
    const sys = rt.store.as(systemCaller("maintenance"));
    const page = await w("pages", { slug: "sys", headline: "h" });
    await store().write([setStatus("pages", page, "published")]);
    expect((await fail(sys.write([{ update: "pages", set: { headline: "x" }, where: { id: page } }])))?.code).toBe("CONFLICT");
    const old = await w("counters", { n: 1, seenAt: "2026-09-30T11:00:00Z" }); // an hour before the runtime's clock, window 60 s
    expect((await sys.select({ from: "counters", columns: ["id"], where: { id: old } })).rows).toEqual([]);
  });

  it("after triggers run in name order, and one that throws does not stop the next", async () => {
    ran.length = 0;
    await w("counters", { n: 1 });
    expect(ran).toEqual(["first", "second"]);
    ran.length = 0;
    failFirst = true;
    try { await w("counters", { n: 1 }); } finally { failFirst = false; }
    expect(ran).toEqual(["first", "second"]);
  });

  it("the depth limit is exactly MAX_INVOCATION_DEPTH", async () => {
    const chain = (n: number): InvocationCause => { let c: InvocationCause = { kind: "internal", id: "0" }; for (let i = 1; i < n; i++) c = { kind: "internal", id: String(i), parent: c }; return c; };
    const call = (n: number) => rt.invokeProcedure({ procedure: "noop", input: {}, caller: user, cause: chain(n) });
    await expect(call(MAX_INVOCATION_DEPTH)).resolves.toEqual({});
    expect((await fail(call(MAX_INVOCATION_DEPTH + 1)))?.code).toBe("INVOCATION_DEPTH_EXCEEDED");
  });
});
