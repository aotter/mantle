// @ts-nocheck the original compiler fixtures intentionally expose inspectable plans
import {beforeAll,describe,expect,it} from "vitest";
import {lowerPlan} from "../../src/build/core/sql/lowered.js";
import {MANTLE_VERSION} from "../../src/build/core/version.js";
import {d1Dialect} from "../../src/build/d1/dialect.js";
import {postgresDialect} from "../../src/build/postgres/dialect.js";
import * as pgCompile from "../../src/build/postgres/compile/index.js";
import {compile} from "./lowered-fixture.js";
let plan,lowered;
beforeAll(async()=>{plan=await compile();lowered=lowerPlan(plan,d1Dialect).lowered;},60000);
describe("lowerPlan", () => {
  it("is deterministic, survives JSON and records the native dialect", async () => {
    expect(lowerPlan(plan, d1Dialect).lowered).toEqual(lowered);
    expect(JSON.parse(JSON.stringify(lowered))).toEqual(lowered);
    const pg = lowerPlan(await compile(pgCompile), postgresDialect()).lowered;
    expect(pg.dialect).toEqual({ name: "@aotter/mantle/postgres", version: "2", key: "UTC" });
  });

  it("holds every View and inline Procedure, by mode, with the default paged shapes and no ASTs", async () => {
    const l = lowered;
    expect(l).toMatchObject({ mantle: MANTLE_VERSION, dialect: { name: "@aotter/mantle/d1", key: "" } });
    expect(Object.keys(l.views)).toEqual(["shelf", "low-stock", "everything"]);
    expect(Object.keys(l.views.shelf)).toEqual(["public"]);
    expect(Object.keys(l.views["low-stock"])).toEqual(["caller", "trusted"]);
    expect(Object.keys(l.procedures)).toEqual(["add-item", "take"]);
    expect(Object.keys(l.procedures["add-item"])).toEqual(["caller", "trusted"]);
    // the key's count and an all-non-null cursor, and the page size is a bind
    const shelf = l.views.shelf.public;
    expect(Object.keys(shelf.paged)).toHaveLength(2);
    expect(Object.values(shelf.paged).every((p) => p.sources.at(-1)?.limit === true && /LIMIT \?\d+$/.test(p.sql))).toBe(true);
    expect(Object.keys(l.views.everything.caller.paged)).toHaveLength(1); // no ORDER BY: no cursor shape
    expect(JSON.stringify(l)).not.toContain("SelectStmt");
    // the hook set reaches the insert's statement
    expect(l.procedures["add-item"].caller[0]).toMatchObject({ hooked: true, returns: true, verb: "insert", target: "items" });
    expect(l.procedures.take.caller[0]).toMatchObject({ verb: "update", target: "items" });
    expect(l.procedures.take.caller[0].hooked).toBeUndefined();
  });

  it("names a program the runtime would refuse, and leaves it out", async () => {
    const text = (await import("./lowered-fixture.js")).MANIFESTS;
    const refused = await compile(undefined, text);
    const body = structuredClone(refused);
    // a View whose IR the dialect refuses once it is tampered with: lowering skips it, as a run would refuse it
    body.views.shelf.stmts[0].SelectStmt.targetList.push({ ResTarget: { val: { FuncCall: { funcname: [{ String: { sval: "no_such_function" } }], args: [] } } } });
    const { lowered: out, warnings } = lowerPlan(body, d1Dialect);
    expect(warnings.join("\n")).toMatch(/plan#\/views\/shelf \(public\)/);
    expect(out.views.shelf).toBeUndefined();
    expect(out.views["low-stock"]).toBeDefined();
  });
});
