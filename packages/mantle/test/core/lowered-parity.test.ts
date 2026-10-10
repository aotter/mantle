// @ts-nocheck test code over loosely typed IR and rows
/**
 * Generate-time lowering (ADR-0044) must be invisible: for every printer-corpus View and Procedure, both dialects, every mode, caller
 * and request shape, a program whose statements were lowered, round-tripped through JSON and seeded emits exactly the SQL and binds
 * (and the refusals) the existing cached path emits. The reference is a copy of the program with identities of its own, run through
 * the ordinary compile path on an executor of its own.
 */
import { expect, it, vi } from "vitest";
import { d1Dialect } from "../../src/d1/dialect.js";
import { SqliteStoreExecutor } from "../../src/d1/executor.js";
import * as d1Compile from "../../src/d1/compile/index.js";
import { postgresDialect } from "../../src/postgres/dialect.js";
import { PgStoreExecutor } from "../../src/postgres/executor.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { compileProgram } from "../../src/core/sql/compile.js";
import { lowerProcedure, lowerView, seedPlan } from "../../src/core/sql/lowered.js";
import { NOW, program, runProcedure, runView, schemas, useCompileSide } from "../../src/testing/harness.js";
import { corpus } from "../../src/testing/cases/corpus.js";
import { MANTLE_VERSION } from "../../src/core/version.js";

const CALLERS = [
  { name: "anonymous", uid: null, role: undefined },
  { name: "owner", uid: "o1", role: undefined },
  { name: "staff", uid: "o1", role: "staff" },
];
const MODES = ["caller", "public", "trusted"] as const;

/** The paged requests a View can get: the lowered shapes at several page sizes, and every shape that is not lowered. */
const PAGES = [
  {},
  { pageSize: 1 },
  { pageSize: 3 },
  { pageSize: 7 },
  { pageSize: 50 },
  { pageSize: 500 },
  { pageSize: 50, cursor: ["a", "b"] },
  { pageSize: 3, cursor: ["a"] },
  { pageSize: 3, cursor: ["a", "b"] },
  { pageSize: 500, cursor: ["a", "b", "c"] },
  { pageSize: 3, cursor: [null] },
  { pageSize: 3, cursor: ["a", null] },
  { pageSize: 3, cursor: [null, null] },
  { pageSize: 3, cursor: [] },
  { pageSize: 3, cursor: ["a", undefined] },
];

function recorder() {
  const log: unknown[] = [];
  const client = {
    query: async (config: { text: string; values?: unknown[] }) => (log.push({ text: config.text, values: config.values }), { rows: [], rowCount: 0, fields: [] }),
    end: async () => undefined,
  };
  return { log, connect: async () => client as never, driver: { batch: async (stmts: { sql: string; binds?: unknown[] }[]) => (log.push(...stmts.map((s) => ({ sql: s.sql, binds: s.binds }))), stmts.map(() => ({ rows: [{ n: 0 }], changes: 0 }))) } as never };
}

const ENGINES = {
  postgres: { dialect: postgresDialect(), compile: pgCompile, executor: (r: ReturnType<typeof recorder>) => new PgStoreExecutor(r.connect, schemas, new Map()), text: (s) => s.text },
  d1: { dialect: d1Dialect, compile: d1Compile, executor: (r: ReturnType<typeof recorder>) => new SqliteStoreExecutor(r.driver), text: (s) => s.sql },
};

async function emit(exec: ReturnType<typeof recorder>, run: () => Promise<unknown>) {
  const from = exec.log.length;
  let err: string | undefined;
  try { await run(); } catch (e) { err = String(e.diagnostic?.message ?? e.message); }
  return JSON.stringify({ sent: exec.log.slice(from), err });
}

const bindOf = (c: (typeof CALLERS)[number], input: Record<string, unknown> | undefined) => ({ uid: c.uid, now: NOW, input: input ?? {}, ...(c.role ? { role: c.role } : {}) });
/** After hooks on every write of every Schema: `hooked` statements with RETURNING of the whole row. */
const VERBS = ["insert", "update", "delete"];
const ALL_HOOKS = new Set(Object.keys(schemas).flatMap((s) => VERBS.map((v) => `${s}.${v}`)));
const hooksOf = (returning) => (returning ? { after: Object.fromEntries(Object.keys(schemas).map((s) => [s, Object.fromEntries(VERBS.map((v) => [v, () => undefined]))])) } : undefined);

/** A plan stub holding one program, lowered by the engine's dialect, through JSON, and seeded onto the program's own objects. */
function seeded(e, item, p, returning: ReadonlySet<string> | undefined) {
  const env = { dialect: e.dialect, schemas };
  const lowered = { mantle: MANTLE_VERSION, dialect: { name: e.dialect.name, version: e.dialect.version, key: e.dialect.lowerKey ?? "" }, views: {}, procedures: {} };
  const plan = { schemas, views: {}, procedures: {}, triggers: {}, lowered };
  if (item.kind === "view") {
    plan.views.x = { stmts: p.ir, inputs: p.inputs, surface: "staff" };
    const modes = Object.fromEntries(MODES.flatMap((m) => { const x = lowerView(env, p, m); return x ? [[m, x]] : []; }));
    if (Object.keys(modes).length) lowered.views.x = modes;
  } else {
    plan.procedures.x = { handler: { sql: { stmts: p.ir } }, inputs: p.inputs };
    const modes = Object.fromEntries(["caller", "trusted"].flatMap((m) => { const x = lowerProcedure(env, p, m, returning); return x ? [[m, x]] : []; }));
    if (Object.keys(modes).length) lowered.procedures.x = modes;
  }
  plan.lowered = JSON.parse(JSON.stringify(lowered)); // the plan crosses JSON
  seedPlan(plan, e.dialect, returning);
  return plan.lowered;
}

for (const [name, e] of Object.entries(ENGINES)) {
  it(`${name}: a lowered, JSON-round-tripped and seeded program emits the cached path's SQL and binds`, async () => {
    useCompileSide(e.compile);
    try {
      let compared = 0, lowered = 0;
      for (const base of corpus) {
        const item = e.dialect.nativeSql && base.native ? { ...base, ...base.native } : base;
        const p = await program(item.kind, item.sql, item.inputs ?? {}).catch((x) => (/^SQL_(UNSUPPORTED|FUNCTION|TYPE):/.test(x.message) ? undefined : Promise.reject(x)));
        if (!p) continue;
        const frozen = JSON.stringify(p.ir);
        const first = p.ir[0]?.SelectStmt?.targetList?.[0]?.ResTarget;
        const out = first?.name ?? first?.val?.ColumnRef?.fields?.at(-1)?.String?.sval;
        const matches = item.kind === "view" && out ? [{ pageSize: 3, match: { search: { columns: [out], text: "x_1" } } }, { pageSize: 50, cursor: ["a", "b"], match: { search: { columns: [out], text: "y%" }, eq: [{ column: out, value: "q" }] } }, { pageSize: 5, match: { eq: [{ column: out, value: 1 }] } }] : [];
        const requests = item.kind === "view" ? [...PAGES, ...matches] : [{}];
        // a Procedure runs without and with after hooks, whose RETURNING the lowered statement must carry
        for (const returning of item.kind === "view" ? [undefined] : [undefined, ALL_HOOKS]) {
          const reference = new Map<string, string>();
          for (const mode of MODES) {
            const rec = recorder();
            const site = { schemas, dialect: e.dialect, executor: e.executor(rec), mode, hooks: hooksOf(returning) };
            const q = structuredClone(p);
            for (const c of CALLERS) for (const [i, req] of requests.entries())
              reference.set(`${mode}|${c.name}|${i}`, await emit(rec, () => (item.kind === "view" ? runView(site, q, bindOf(c, item.input), req) : runProcedure(site, q, bindOf(c, item.input)))));
          }
          const sealed = structuredClone(p);
          const plan = seeded(e, item, sealed, returning);
          lowered += Object.keys(plan.views).length + Object.keys(plan.procedures).length;
          for (const mode of MODES) {
            const rec = recorder();
            const site = { schemas, dialect: e.dialect, executor: e.executor(rec), mode, hooks: hooksOf(returning) };
            // twice over: the second round is all hits on whatever the first one compiled
            for (let round = 0; round < 2; round++)
              for (const c of CALLERS) for (const [i, req] of requests.entries()) {
                const got = await emit(rec, () => (item.kind === "view" ? runView(site, sealed, bindOf(c, item.input), req) : runProcedure(site, sealed, bindOf(c, item.input))));
                expect(got, `${item.id} ${mode} ${c.name} request ${i} (${JSON.stringify(req)}) round ${round} returning ${!!returning}`).toBe(reference.get(`${mode}|${c.name}|${i}`));
                compared++;
              }
          }
          expect(JSON.stringify(sealed.ir), `${item.id}: the sealed IR`).toBe(frozen);
        }
      }
      expect(compared).toBeGreaterThan(1000);
      expect(lowered, "the corpus lowers").toBeGreaterThan(40);
    } finally {
      useCompileSide(undefined);
    }
  }, 900_000);

  it(`${name}: the lowered statements survive JSON, and dialect.print is the text the executor runs`, async () => {
    useCompileSide(e.compile);
    try {
      let statements = 0;
      for (const base of corpus) {
        const item = e.dialect.nativeSql && base.native ? { ...base, ...base.native } : base;
        const p = await program(item.kind, item.sql, item.inputs ?? {}).catch((x) => (/^SQL_(UNSUPPORTED|FUNCTION|TYPE):/.test(x.message) ? undefined : Promise.reject(x)));
        if (!p) continue;
        const env = { dialect: e.dialect, schemas };
        const stmts = item.kind === "view"
          ? [lowerView(env, p, "caller")].filter(Boolean)
          : lowerProcedure(env, p, "caller", ALL_HOOKS) ?? [];
        // binds and metadata are JSON: nothing is lost on the way through plan.json
        expect(JSON.parse(JSON.stringify(stmts)), item.id).toEqual(stmts);
        // the printer the plan was lowered by is the one the executor prints with: same AST, same text
        const compiled = compileProgram(p.ir, { dialect: e.dialect, schemas, inputs: p.inputs, kind: item.kind, mode: "caller", ...(item.kind === "procedure" ? { returning: ALL_HOOKS } : {}) });
        const printed = compiled.map((c) => e.dialect.print(c.ast, schemas));
        expect(stmts.map((s) => s.sql), item.id).toEqual(printed);
        const rec = recorder();
        const site = { schemas, dialect: e.dialect, executor: e.executor(rec), mode: "caller", hooks: hooksOf(ALL_HOOKS) };
        await (item.kind === "view" ? runView(site, structuredClone(p), bindOf(CALLERS[1], item.input)) : runProcedure(site, structuredClone(p), bindOf(CALLERS[1], item.input))).catch(() => undefined);
        const sent = rec.log.map(e.text).filter((t) => !/^INSERT INTO _mantle_assert|^SELECT changes\(\)|^BEGIN|^COMMIT/.test(t));
        // a PostgreSQL write with an expected count is wrapped in the count's own CTE, around the printed text
        printed.forEach((text, i) => expect(sent[i], `${item.id} statement ${i}`).toSatisfy((t) => (name === "postgres" && item.kind === "procedure" ? t.includes(text) : t === text)));
        statements += printed.length;
      }
      expect(statements).toBeGreaterThan(40);
    } finally {
      useCompileSide(undefined);
    }
  }, 600_000);

  it(`${name}: the default shapes compile nothing at any page size; a NULL-key cursor compiles once`, async () => {
    useCompileSide(e.compile);
    try {
      const check = vi.fn(e.dialect.check);
      const dialect = { ...e.dialect, check };
      const env = { dialect, schemas };
      const p = await program("view", "SELECT id, name FROM items ORDER BY name, id");
      const sealed = structuredClone(p);
      const lowered = { mantle: MANTLE_VERSION, dialect: { name: dialect.name, version: dialect.version, key: dialect.lowerKey ?? "" }, procedures: {},
        views: { x: Object.fromEntries(["caller", "trusted"].map((m) => [m, lowerView(env, p, m)])) } };
      const plan = { schemas, views: { x: { stmts: sealed.ir, inputs: sealed.inputs, surface: "staff" } }, procedures: {}, triggers: {}, lowered: JSON.parse(JSON.stringify(lowered)) };
      check.mockClear();
      seedPlan(plan, dialect, undefined);
      const nkeys = plan.lowered.views.x.caller.nkeys;
      expect(nkeys).toBeGreaterThan(0);
      for (const mode of ["caller", "trusted"]) {
        const rec = recorder();
        const site = { schemas, dialect, executor: e.executor(rec), mode };
        for (const pageSize of [1, 7, 50, 500]) {
          await runView(site, sealed, bindOf(CALLERS[1], {}), { pageSize });
          await runView(site, sealed, bindOf(CALLERS[1], {}), { pageSize, cursor: Array(nkeys).fill("a") });
        }
        expect(check, `${mode}: lowered shapes`).toHaveBeenCalledTimes(0);
        // one statement serves every page size: only the last bind differs
        const texts = new Set(rec.log.map((s) => e.text(s)));
        expect(texts.size).toBe(2);
        await runView(site, sealed, bindOf(CALLERS[1], {}), { pageSize: 7, cursor: ["a", null] });
        await runView(site, sealed, bindOf(CALLERS[1], {}), { pageSize: 9, cursor: ["b", null] });
        expect(check, `${mode}: a NULL key compiles once, lazily`).toHaveBeenCalledTimes(1);
        check.mockClear();
      }
    } finally {
      useCompileSide(undefined);
    }
  });
}
