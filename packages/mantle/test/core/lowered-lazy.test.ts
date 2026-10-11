// @ts-nocheck cache counters over JSON plans and loosely typed rows
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("../../src/core/sql/run.js", async (load) => { const m = await load(); return { ...m, seedCompiled: vi.fn(m.seedCompiled), seedPaged: vi.fn(m.seedPaged) }; });
vi.mock("../../src/d1/print.js", async (load) => { const m = await load(); return { ...m, print: vi.fn(m.print) }; });
vi.mock("../../src/core/sql/policy.js", async (load) => { const m = await load(); return { ...m, applyPolicy: vi.fn(m.applyPolicy) }; });

import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { createMantleRuntime } from "../../src/core/index.js";
import { seedPlan, withLowering } from "../../src/core/sql/lowered.js";
import { runProcedure, runView, seedCompiled, seedPaged } from "../../src/core/sql/run.js";
import { applyPolicy } from "../../src/core/sql/policy.js";
import { print } from "../../src/d1/print.js";
import { d1Dialect } from "../../src/d1/dialect.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { anonymous, compile, deterministic, handlers, reseal, user } from "./lowered-fixture.js";

let original;
const dbs = [];
beforeAll(async () => { original = (await withLowering(await compile(), d1Dialect)).plan; }, 60_000);
afterAll(() => Promise.all(dbs.map((d) => d.dispose())));
const reset = () => { for (const f of [seedCompiled, seedPaged, applyPolicy, print]) vi.mocked(f).mockClear(); };
const installed = () => [vi.mocked(seedCompiled).mock.calls.length, vi.mocked(seedPaged).mock.calls.length];
async function boot(plan = structuredClone(original)) {
  const db = await LocalD1.create(); dbs.push(db);
  const storage = sqliteStorage(db), check = vi.fn(storage.dialect.check);
  const rt = await createMantleRuntime({ plan, storage: { ...storage, dialect: { ...storage.dialect, check } }, handlers, ...deterministic() });
  return { rt, check };
}

it("boot allocates no lowered AST descriptors or cache seeds; first use adopts only that program and mode", async () => {
  reset();
  const descriptors = vi.spyOn(Object, "defineProperty");
  try {
    const { rt, check } = await boot();
    const astDescriptors = () => descriptors.mock.calls.filter(([, key, d]) => key === "ast" && d.enumerable && d.get).length;
    expect(installed()).toEqual([0, 0]);
    expect(astDescriptors()).toBe(0);
    vi.mocked(applyPolicy).mockClear(); vi.mocked(print).mockClear(); check.mockClear();
    await rt.store.as(anonymous).view("shelf");
    expect(installed()).toEqual([1, 2]);
    expect(astDescriptors()).toBe(3); // only shelf.public + two page shapes
    await rt.store.as(anonymous).view("shelf", { limit: 7 });
    expect(installed()).toEqual([1, 2]);
    expect(astDescriptors()).toBe(3);
    await rt.store.as(user("owner")).view("low-stock", { input: { max: 10 } });
    expect(installed()).toEqual([2, 4]);
    await rt.store.view("low-stock");
    expect(installed()).toEqual([3, 6]); // caller and trusted never share a seed
    const add = (name) => rt.invokeProcedure({ procedure: "add-item", input: { name, stock: 4 }, caller: user("owner"), cause: { kind: "http", id: name } });
    await add("one"); await add("two");
    expect(installed()).toEqual([4, 6]);
    expect(astDescriptors()).toBe(10);
    expect(check).not.toHaveBeenCalled(); expect(applyPolicy).not.toHaveBeenCalled(); expect(print).not.toHaveBeenCalled();
  } finally { descriptors.mockRestore(); }
});

it("a malformed unused View disables the entire seed at boot, before any installation", async () => {
  const bad = await reseal(original, (p) => {
    const page = Object.values(p.lowered.views.everything.trusted.paged)[0]; delete page.sources; return p;
  });
  reset();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { rt, check } = await boot(bad);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(installed()).toEqual([0, 0]);
    check.mockClear();
    await rt.store.as(anonymous).view("shelf");
    expect(installed()).toEqual([0, 0]);
    expect(check).toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

it("the first-use callback requires the plan's exact name, input and IR identities", async () => {
  const p = structuredClone(original), seed = seedPlan(p, d1Dialect, undefined);
  const v = p.views.shelf;
  const program = { name: "shelf", kind: "view", inputs: v.inputs, ir: v.stmts };
  reset();
  for (const changed of [{ name: "missing" }, { inputs: { ...v.inputs } }, { ir: structuredClone(v.stmts) }, { kind: "procedure" }]) seed({ ...program, ...changed }, "public");
  expect(installed()).toEqual([0, 0]);
  seed(program, "public");
  expect(installed()).toEqual([1, 2]);
});

it("probe misses and writes with an all-undefined statuses array cannot invoke the lazy installer", async () => {
  const p = structuredClone(original), v = p.views.shelf;
  const seed = vi.fn(seedPlan(p, d1Dialect, undefined));
  const executor = { select: async () => [] };
  for (const probe of [{ seen: new Set() }, { unsafeNoVisibility: true }]) {
    const program = { name: "shelf", kind: "view", inputs: v.inputs, ir: v.stmts };
    await runView({ ...probe, seedLowered: seed, executor, schemas: p.schemas, dialect: d1Dialect, mode: "public" }, program,
      { caller: anonymous, cause: { kind: "http", id: "probe" }, bind: { uid: null, now: 1_800_000_000_000_000 } });
  }
  const proc = p.procedures["add-item"];
  await runProcedure({ seedLowered: seed, executor: { apply: async (batch) => batch.map(() => ({ affected: 1, rows: [] })) }, schemas: p.schemas, dialect: d1Dialect, mode: "caller" },
    { name: "add-item", kind: "procedure", inputs: proc.inputs, ir: proc.handler.sql.stmts, statuses: [undefined] },
    { caller: user("owner"), cause: { kind: "http", id: "status" }, bind: { uid: "owner", now: 1_800_000_000_000_000, input: { name: "status", stock: 1 } } });
  expect(seed).not.toHaveBeenCalled();
});
