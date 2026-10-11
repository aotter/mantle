import { describe, expect, it } from "vitest";
import ts from "typescript";
import { emitBinder, emitBinders, emitInputProjector } from "../../src/cli/emitBinders.js";
import { bindValues, sqlInput, type BindContext } from "../../src/core/sql/compile.js";
import type { BindSpec } from "../../src/core/sql/policy.js";
import type { MantleDialect } from "../../src/core/dialect.js";
import * as sqlite from "../../src/d1/codec.js";
import * as pg from "../../src/postgres/codec.js";
import { d1Dialect } from "../../src/d1/dialect.js";
import { postgresDialect } from "../../src/postgres/dialect.js";

const sourceFunction = (source: string, helpers: Record<string, unknown> = {}) => {
  const js = ts.transpileModule(`const fn = ${source};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(helpers), `${js}; return fn;`)(...Object.values(helpers));
};
const outcome = (f: () => unknown) => {
  try { return { value: f() }; }
  catch (e) { return { error: { name: (e as Error).name, message: (e as Error).message, ...e as object } }; }
};
const ctx: BindContext = { uid: "scope-a", role: null, now: 1_796_000_000_123_456 };
const encoders = { sqlite, postgres: { ...sqlite, ...pg } };

for (const [name, dialect] of [["sqlite", d1Dialect], ["postgres", postgresDialect()]] as const) describe(`${name} generated bind values`, () => {
  it("matches every recipe, typed codec value and error on first and repeated calls", () => {
    const values: [string, unknown[]][] = [
      ["text", [undefined, null, "", 42, false, { label: "text" }]],
      ["bool", [null, undefined, false, true, 0, 1, "false"]],
      ["int4", [0, -12, Number.MAX_SAFE_INTEGER, 1.2, Infinity, "1"]],
      ["int8", [0, Number.MAX_SAFE_INTEGER + 1]], ["integer", [undefined, null, -1]],
      ["real", [null, 1.25, -Infinity]], ["float8", [undefined, NaN, 2.5]],
      ["numeric(8, 2)", [null, "12.30", " -12.34 ", 12.34, "1.234", "1234567.89", "1e2", {}]],
      ["json", [null, undefined, "string", { a: [false, null, 1] }, [1, 2], 3n]],
      ["date", [null, "2024-02-29", "2026-02-30", "0026-01-01", new Date("2026-01-03T00:00:00Z"), "bad"]],
      ["timestamptz", [undefined, ctx.now, "2026-10-10T01:02:03.123456+08:00", "2026-10-10T01:02:03", "2026-02-30T00:00:00Z", 0.5, new Date("2026-01-03T00:00:00Z")]],
      ["geo", [null, "POINT(1 2)", { lat: 1, lng: 2 }]],
    ];
    for (const [type, corpus] of values) {
      const recipe: BindSpec[] = [{ k: "uid" }, { k: "role" }, { k: "now" }, { k: "cutoff", seconds: 61 }, { k: "const", value: "literal" }, { k: "input", name: "itemid", type }, { k: "version" }, { k: "cursor", i: 1 }];
      const generated = sourceFunction(emitBinder(recipe, name), encoders[name]);
      for (const value of corpus) for (let call = 0; call < 2; call++) {
        const context = { ...ctx, uid: call ? null : ctx.uid, role: call ? "editor" : undefined, input: { itemid: value } };
        const extra = { version: call + 3, cursor: ["ignored", null] };
        expect(outcome(() => generated(context, extra, dialect))).toEqual(outcome(() => bindValues(dialect, recipe, context, extra)));
      }
    }
  });

  it("preserves dialect binds, evaluation order, missing cursor errors and request isolation", () => {
    const recipe: BindSpec[] = [{ k: "input", name: "x", type: "text" }, { k: "dialect", side: "left" }, { k: "input", name: "x", type: "text" }, { k: "cursor", i: 0 }];
    const generated = sourceFunction(emitBinder(recipe, name), encoders[name]);
    const run = (generatedPath: boolean, cursor: boolean) => {
      const seen: string[] = [];
      let reads = 0;
      const context = { ...ctx, input: { get x() { seen.push("input"); return ++reads; } } };
      const d: MantleDialect = { ...dialect, bind: (_b, c) => { seen.push("dialect"); return c.uid; } };
      const extra = cursor ? { cursor: [7] } : {};
      const result = outcome(() => generatedPath ? generated(context, extra, d) : bindValues(d, recipe, context, extra));
      return { result, seen };
    };
    expect(run(true, true)).toEqual(run(false, true));
    expect(run(true, false)).toEqual(run(false, false));
  });
});

it("projects only declared own input names, folding exactly as sqlInput including absent values", () => {
  const schema = { type: "object" as const, properties: { itemId: { type: "string" as const }, optional: { type: "string" as const }, ["__proto__"]: { type: "string" as const } } };
  const generated = sourceFunction(emitInputProjector(schema));
  for (const input of [undefined, null, {}, { itemId: null, ITEMID: "injected" }, Object.assign(Object.create({ itemId: "inherited" }), { optional: "own" }), JSON.parse('{"__proto__":"declared","itemId":"real","ITEMID":"injected"}')]) {
    expect(generated(input)).toEqual(sqlInput(schema, input));
    expect(Object.keys(generated(input))).toEqual(Object.keys(sqlInput(schema, input)));
  }
  expect(sourceFunction(emitInputProjector(undefined))({ injected: true })).toEqual({});
});

it("omits unused ref handler projectors with valid case-distinct JavaScript inputs", async () => {
  const { compile } = await import("../core/lowered-fixture.js");
  const { withLowering } = await import("../../src/core/sql/lowered.js");
  const { plan } = await withLowering(await compile(), d1Dialect);
  const procedure = Object.values(plan.procedures)[0]!;
  const withRef = { ...plan, procedures: { ...plan.procedures, refInput: { ...procedure,
    handler: { ref: "handler" }, input: { type: "object" as const, properties: { foo: { type: "string" as const }, Foo: { type: "string" as const } } },
  } } };
  const emitted = emitBinders(withRef)!;
  const projects = sourceFunction(`() => (${emitted.projectors})`)();
  expect(Object.hasOwn(projects.procedure, "refInput")).toBe(false);
  expect(emitted.projectors).not.toContain('given["Foo"]');
});

it("emits the complete lowered program/mode table and preserves page extras on cold and warm calls", async () => {
  const { compile, user } = await import("../core/lowered-fixture.js");
  const { withLowering } = await import("../../src/core/sql/lowered.js");
  const { runView, runProcedure } = await import("../../src/core/sql/run.js");
  for (const dialect of [d1Dialect, postgresDialect()]) {
    const compiler = dialect === d1Dialect ? undefined : await import("../../src/postgres/compile/index.js");
    const { plan } = await withLowering(await compile(compiler), dialect);
    const emitted = emitBinders(plan)!;
    const table = sourceFunction(`() => (${emitted.binders})`, { ...sqlite, ...(dialect === d1Dialect ? {} : pg) })();
    const projects = sourceFunction(`() => (${emitted.projectors})`)();
    expect(Object.keys(table.view)).toEqual(Object.keys(plan.lowered!.views));
    expect(Object.keys(table.procedure)).toEqual(Object.keys(plan.lowered!.procedures));
    let generatedCalls = 0;
    for (const programs of Object.values(table) as any[]) for (const modes of Object.values(programs) as any[]) for (const [mode, fs] of Object.entries(modes) as [string, Function[]][]) modes[mode] = fs.map((f) => (...args: unknown[]) => { generatedCalls++; return f(...args); });
    const statements: unknown[][] = [];
    const env = { dialect, schemas: plan.schemas, executor: {
      select: async (s: { binds: readonly unknown[] }) => { statements.push([...s.binds]); return []; },
      apply: async (batch: readonly { binds: readonly unknown[] }[]) => batch.map((s) => { statements.push([...s.binds]); return { affected: 1, rows: [] }; }),
    } };
    const as = { caller: user("scope-a"), cause: { id: "call", kind: "invoke" } as any, bind: { ...ctx, input: { max: 10 } } };
    const view = plan.views["low-stock"]!;
    const p = { kind: "view" as const, name: "low-stock", inputs: view.inputs, ir: view.stmts };
    expect(projects.view["low-stock"]({ max: 10, MAX: 99 })).toEqual(sqlInput(view.input, { max: 10, MAX: 99 }));
    for (const opts of [{}, { pageSize: 2 }, { pageSize: 5, cursor: [null, "last-id"] }, { pageSize: 7, cursor: [10, "last-id"], match: { search: { text: "a%_", columns: ["id"] }, eq: [{ column: "stock", value: 3 }] } }]) {
      for (let warm = 0; warm < 2; warm++) {
        statements.length = 0;
        await runView(env, p, as, opts);
        const interpreted = [...statements];
        statements.length = 0;
        await runView({ ...env, generatedBinders: table }, p, as, opts);
        expect(statements).toEqual(interpreted);
      }
    }
    const proc = plan.procedures["take"]!;
    if (!("sql" in proc.handler)) throw new Error("expected inline Procedure");
    const write = { kind: "procedure" as const, name: "take", inputs: proc.inputs, ir: proc.handler.sql.stmts };
    const writeAs = { ...as, bind: { ...ctx, input: { id: "record", qty: 1 } } };
    statements.length = 0;
    await runProcedure(env, write, writeAs);
    const interpreted = [...statements];
    statements.length = 0;
    await runProcedure({ ...env, generatedBinders: table }, write, writeAs);
    expect(statements).toEqual(interpreted);
    expect(generatedCalls).toBe(9);
    for (const negative of [{ ...env, seen: new Set<any>() }, { ...env, unsafeNoVisibility: true }]) await runView({ ...negative, generatedBinders: table }, p, as);
    await runView({ ...env, generatedBinders: table }, { ...p, name: undefined }, as);
    // A name omitted by lowering must not pick up Object.prototype.constructor or its restricted caller property.
    await runView({ ...env, generatedBinders: table }, { ...p, name: "constructor" }, as);
    await runProcedure({ ...env, generatedBinders: table }, { ...write, statuses: [] }, writeAs);
    expect(generatedCalls).toBe(9);
    // Publishing switches this statement to the version-pinned "one" recipe after preRead.
    // Its extra version bind must never be replaced by the registered "all" function.
    const publishingEnv = { ...env, schemas: { ...env.schemas, items: { ...env.schemas.items!, publishing: true } }, executor: {
      ...env.executor,
      select: async (s: { binds: readonly unknown[] }) => { statements.push([...s.binds]); return [{ id: "record", version: 8, status: "draft", stock: 3 }]; },
    } };
    statements.length = 0;
    await runProcedure(publishingEnv, write, writeAs);
    const locked = [...statements];
    statements.length = 0;
    await runProcedure({ ...publishingEnv, generatedBinders: table }, write, writeAs);
    expect(statements).toEqual(locked);
    expect(statements.at(-1)).toContain(8);
    expect(generatedCalls).toBe(9);
    expect(emitBinders({ ...plan, lowered: undefined })).toBeUndefined();
    expect(emitBinders({ ...plan, lowered: { ...plan.lowered!, dialect: { name: "third-party", version: "1", key: "" } } })).toBeUndefined();
  }
});
