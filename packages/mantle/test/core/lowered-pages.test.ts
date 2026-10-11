// @ts-nocheck loosely typed captured statements and intentionally malformed metadata
import { expect, it, vi } from "vitest";
import { MANIFESTS, compile, user, reseal } from "./lowered-fixture.js";
import { lowerView, seedPlan, withLowering, LOWERED_VIEW_SHAPE_LIMIT } from "../../src/core/sql/lowered.js";
import { pageShape, runView } from "../../src/core/sql/run.js";
import { d1Dialect } from "../../src/d1/dialect.js";
import { postgresDialect } from "../../src/postgres/dialect.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { verifyPlan } from "../../src/core/runtime/verifyPlan.js";
import { sqliteStorage } from "../../src/d1/index.js";

const text = MANIFESTS.replace("surface: staff\n  input:", "surface: staff\n  uiSchema: { list: { searchFields: [name, id], filterFields: [name, stock, id] } }\n  input:");
const context = { caller: user("owner"), cause: { id: "call", kind: "invoke" }, bind: { uid: "owner", role: null, now: 1_800_000_000_000_000, input: { max: 42 } } };
const match = (search = false, columns: string[] = []) => ({ ...(search ? { search: { columns: ["name", "id"], text: "a%_\\" } } : {}), eq: columns.map((column) => ({ column, value: column === "stock" ? 3 : "x" })) });

for (const [name, dialect, compiler] of [["sqlite", d1Dialect, undefined], ["postgres", postgresDialect(), pgCompile]]) {
  it(`${name}: seeds bounded staff list shapes with identical SQL, lazy AST and request binds`, async () => {
    const original = await compile(compiler, text);
    const { plan, warnings } = await withLowering(original, dialect);
    expect(warnings).toEqual([]);
    const baseline = await withLowering({ ...original, views: Object.fromEntries(Object.entries(original.views).map(([n, v]) => [n, { ...v, uiSchema: undefined }])) }, dialect);
    const pages = plan.lowered.views["low-stock"].caller.paged;
    const nkeys = plan.lowered.views["low-stock"].caller.nkeys;
    const afterKeys = [2, ...Array(nkeys - 1).fill("id-2")];
    expect(Object.keys(pages)).toHaveLength(16);
    const addedBytes = JSON.stringify(plan.lowered).length - JSON.stringify(baseline.plan.lowered).length;
    expect(addedBytes).toBeGreaterThan(0);
    expect(addedBytes).toBeLessThan(50_000); // this three-filter fixture, including both caller and trusted modes
    console.info(`${name} optional list seeds: +${addedBytes} JSON bytes, +28 pages (two modes)`);
    expect(Object.keys(plan.lowered.views.shelf.public.paged)).toHaveLength(2);

    const seeded = JSON.parse(JSON.stringify(plan));
    const fallback = JSON.parse(JSON.stringify(original));
    const check = vi.fn(dialect.check);
    const counted = { ...dialect, check };
    seedPlan(seeded, counted, undefined);
    const record = async (p, d, options, inspectAst = false, mode = "caller") => {
      let sent;
      const v = p.views["low-stock"];
      const executor = { select: async (s) => { sent = { sql: s.printed?.sql ?? d.print(s.ir, p.schemas), binds: s.binds, ...(inspectAst ? { lazySql: d.print(s.ir, p.schemas) } : {}) }; return []; } };
      await runView({ dialect: d, schemas: p.schemas, executor, mode }, { kind: "view", inputs: v.inputs, ir: v.stmts }, context, options);
      return sent;
    };
    for (const m of [undefined, match(true), match(false, ["stock"]), match(true, ["name"])]) for (const cursor of [undefined, afterKeys]) for (const size of [1, 500]) {
      const options = { pageSize: size, cursor, match: m };
      expect(pages[pageShape(plan.lowered.views["low-stock"].caller.nkeys, cursor, m)], JSON.stringify(options)).toBeDefined();
      for (const mode of ["caller", "trusted"]) expect(await record(seeded, counted, options, false, mode)).toEqual(await record(fallback, dialect, options, false, mode));
    }
    expect(check).not.toHaveBeenCalled(); // matching seeded shapes never touch the policy AST
    for (const m of [match(true), match(false, ["stock"]), match(true, ["name"])]) {
      const options = { pageSize: 7, cursor: afterKeys, match: m };
      const real = await record(fallback, dialect, options, true);
      expect(await record(seeded, counted, options, true)).toEqual(real); // introspection restores the full shape, including matches
      expect(real.lazySql).toBe(real.sql);
    }
    for (const options of [
      { pageSize: 3, cursor: [null, ...afterKeys.slice(1)], match: match(true, ["stock"]) },
      { pageSize: 3, match: match(true, ["stock", "id"]) },
      { pageSize: 3, match: { search: { columns: ["id"], text: "different" } } },
    ]) {
      expect(pages[pageShape(nkeys, options.cursor, options.match)]).toBeUndefined();
      expect(await record(seeded, counted, options, true)).toEqual(await record(fallback, dialect, options, true));
    }
  });
}

it("caps attempted shapes, skips optional unsupported metadata and surfaces real printer failures", async () => {
  const plan = await compile();
  const v = plan.views["low-stock"];
  const env = { dialect: d1Dialect, schemas: plan.schemas };
  const p = { inputs: v.inputs, ir: v.stmts };
  const warnings: string[] = [];
  const lower = (list, dialect = d1Dialect) => lowerView({ ...env, dialect }, p, "caller", undefined, (m) => warnings.push(m), "fixture", list);
  const ordinary = lower(undefined);
  expect(Object.keys(lower({ searchFields: "name", filterFields: [7] }).paged)).toEqual(Object.keys(ordinary.paged));
  expect(Object.keys(lower({ searchFields: ["unknown"], filterFields: ["unknown"] }).paged)).toEqual(Object.keys(ordinary.paged));
  expect(warnings).toEqual([]);
  // Known repeated fields are intentionally malformed metadata: attempts still have a fixed ceiling.
  const print = vi.fn(d1Dialect.print);
  const bounded = lower({ filterFields: Array(1_000).fill("stock") }, { ...d1Dialect, print });
  expect(Object.keys(bounded.paged).length).toBeLessThanOrEqual(LOWERED_VIEW_SHAPE_LIMIT);
  expect(print.mock.calls.length).toBe(17); // sixteen attempts and one base statement
  let printed = 0;
  expect(() => lower({ searchFields: ["name"] }, { ...d1Dialect, print: (...args) => { if (++printed === 3) throw new Error("printer defect"); return d1Dialect.print(...args); } })).toThrow("printer defect");
});

it("verifyPlan bounds page counts before re-lowering and rejects tampered match SQL", async () => {
  const { plan } = await withLowering(await compile(undefined, text), d1Dialect);
  const storage = sqliteStorage({} as never);
  expect(await verifyPlan(plan, storage)).toEqual([]);
  const over = await reseal(plan, (p) => {
    const pages = p.lowered.views["low-stock"].caller.paged;
    pages["extra"] = Object.values(pages)[0];
    return p;
  });
  expect((await verifyPlan(over, storage)).some((d) => d.message?.includes("page shapes in one lowered View mode"))).toBe(true);
  const tampered = await reseal(plan, (p) => {
    const pages = p.lowered.views["low-stock"].caller.paged;
    const key = Object.keys(pages).find((shape) => JSON.parse(shape)[1] !== null)!;
    pages[key].sql = "SELECT 1";
    return p;
  });
  expect((await verifyPlan(tampered, storage)).some((d) => d.message?.includes("LOWERING_MISMATCH"))).toBe(true);
});
